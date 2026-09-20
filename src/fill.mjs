import { extractApplicationForm, verifyValues } from "./form.mjs";
import { normalizeAnswers, isProtectedField } from "./contract.mjs";
import { resolveFiniteOptions, validateAppliedAnswers } from "./model.mjs";

const MAX_PAGES = 12;
const BLOCKING_CODES = new Set(["fill-mismatch", "fill-failed", "required-empty", "option-review", "captcha-present", "validation"]);
const FINAL_ACTION_RX = /\b(?:submit|send|apply|finish|complete(?: application)?|confirm(?: application)?|consent)\b/i;
const SAFE_CONTINUATION_RX = /^(?:next|continue|save(?: and continue)?|proceed|go to next|review answers?)$/i;

function cssAttr(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function isFinalActionLabel(label) {
  return FINAL_ACTION_RX.test(cleanLabel(label));
}

export function isSafeContinuationLabel(label) {
  const clean = cleanLabel(label).replace(/[.!:]+$/, "");
  return SAFE_CONTINUATION_RX.test(clean) && !isFinalActionLabel(clean);
}

async function fillField(frame, page, field, value) {
  const selector = `[data-jev-field="${cssAttr(field.id)}"]`;
  const locator = frame.locator(selector).first();
  if (!(await locator.count())) return { ok: false, reason: "live field no longer exists" };
  if (field.type === "file") return { ok: false, reason: "file uploads remain manual" };
  if (field.type === "checkbox" && isProtectedField(field.label)) return { ok: false, reason: "protected confirmation remains manual" };

  try {
    if (field.combobox) {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click();
      await page.waitForTimeout(120);
      await locator.pressSequentially(value, { delay: 10 }).catch(async () => page.keyboard.type(value));
      await page.waitForTimeout(220);
      const optionSelector = '.select__menu .select__option, .select__menu-list [role="option"], [class*="menu" i] [role="option"]';
      const exact = frame.locator(optionSelector).filter({ hasText: new RegExp(`^\\s*${regexEscape(value)}\\s*$`, "i") }).first();
      if (await exact.count()) {
        await exact.click();
      } else {
        const partial = frame.locator(optionSelector).filter({ hasText: new RegExp(regexEscape(value), "i") }).first();
        if (!(await partial.count())) {
          await page.keyboard.press("Escape").catch(() => {});
          return { ok: false, reason: "answer did not match a visible option" };
        }
        await partial.click();
      }
    } else if (field.type === "select") {
      await locator.selectOption({ label: value }).catch(async () => locator.selectOption(value));
    } else if (field.type === "checkbox") {
      const want = ["true", "1", "yes", "on", "checked"].includes(value.toLowerCase());
      await locator.setChecked(want, { timeout: 3_000 });
    } else if (field.type === "radio") {
      const radio = frame.locator(`${selector}[data-jev-option="${cssAttr(value)}"]`).first();
      if (!(await radio.count())) return { ok: false, reason: "answer did not match a visible radio option" };
      await radio.check({ timeout: 3_000 }).catch(async () => radio.check({ force: true }));
    } else {
      await locator.fill(value);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : "fill failed" };
  }
}

async function fillFields({ page, frame, fields, answers }) {
  const steps = [];
  for (const [fieldId, value] of Object.entries(answers)) {
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field || !String(value).trim()) continue;
    const result = await fillField(frame, page, field, String(value));
    steps.push({ fieldId, label: field.label, value: String(value), ok: result.ok, reason: result.reason });
  }
  return steps;
}

async function challengeOnPage(page) {
  return page.evaluate(() => {
    const text = `${document.body?.innerText || ""} ${Array.from(document.querySelectorAll("iframe, [class], [id]")).map((element) => `${element.getAttribute("src") || ""} ${element.getAttribute("class") || ""} ${element.id || ""}`).join(" ")}`;
    return /captcha|recaptcha|hcaptcha|two[- ]factor|multi[- ]factor|one[- ]time password|verification code|sign[ -]?in|log[ -]?in/i.test(text);
  }).catch(() => false);
}

async function clickSafeContinuation(page, frame) {
  const controls = frame.locator('button, a[href], [role="button"], input[type="button"], input[type="submit"]');
  const candidates = await controls.evaluateAll((elements) => elements.map((element, index) => {
    const node = element;
    const input = element;
    const rect = node.getBoundingClientRect();
    return {
      index,
      label: (element.getAttribute("aria-label") || node.innerText || input.value || element.getAttribute("title") || "").replace(/\s+/g, " ").trim(),
      visible: node.offsetParent !== null && rect.width > 2 && rect.height > 2,
      disabled: input.disabled || element.getAttribute("aria-disabled") === "true",
    };
  })).catch(() => []);

  const candidate = candidates.find((control) => control.visible && !control.disabled && isSafeContinuationLabel(control.label));
  if (!candidate) return { clicked: false, reason: "final-page" };

  try {
    const control = controls.nth(candidate.index);
    await control.scrollIntoViewIfNeeded().catch(() => {});
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {}),
      control.click({ timeout: 8_000 }),
    ]);
    await page.waitForTimeout(650);
    return { clicked: true, label: candidate.label };
  } catch (error) {
    return { clicked: false, label: candidate.label, reason: error instanceof Error ? error.message.slice(0, 160) : "continuation click failed" };
  }
}

function mergeModelValidation(current, next, page) {
  return {
    status: [current.status, next.status].includes("error") ? "error" : [current.status, next.status].includes("validated") ? "validated" : "skipped",
    reason: [current.reason, next.reason].filter(Boolean).join(" ") || undefined,
    observed: { ...current.observed, [`page${page}`]: next.observed },
    fields: [...current.fields, ...next.fields.map((field) => ({ ...field, fieldId: `page${page}:${field.fieldId}` }))],
  };
}

function modelIssues(validation) {
  return [
    ...(validation.status === "error" ? [{ level: "warn", code: "validation", message: validation.reason || "TypeSafe validation failed." }] : []),
    ...validation.fields.filter((field) => field.status !== "valid").map((field) => ({ level: "warn", code: "validation", message: `${field.label}: ${field.reason}`, field: field.fieldId })),
  ];
}

function uniqueIssues(issues) {
  return issues.filter((issue, index, all) => all.findIndex((candidate) => candidate.message === issue.message) === index);
}

export async function fillApplication({ page, url, rawAnswers, tabIndex, client }) {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password) throw new Error("url must be an http:// or https:// URL without embedded credentials");

  const current = page.url();
  if (current !== target.href) {
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
  }

  const issues = [];
  const steps = [];
  const pages = [];
  const appliedAnswers = [];
  const matchedKeys = new Set();
  let modelValidation = { status: "skipped", observed: {}, fields: [] };
  let navigated = false;
  let stoppedReason = "final-page";
  let lastForm = null;
  let pageNumber = 0;

  for (pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const extracted = await extractApplicationForm(page);
    if (!extracted.form.fields.length) {
      issues.push({ level: "warn", code: "no-form", message: "No visible application fields were found on the current tab." });
      stoppedReason = "validation";
      break;
    }
    lastForm = extracted;
    const normalized = normalizeAnswers(extracted.form.fields, rawAnswers, { ignoreUnknown: true });
    normalized.issues.forEach((issue) => issues.push(issue));
    normalized.matchedKeys.forEach((key) => matchedKeys.add(key));
    const resolved = await resolveFiniteOptions({ fields: extracted.form.fields, answers: normalized.answers, client });
    issues.push(...resolved.issues);
    const pageAnswers = resolved.answers;

    for (const [fieldId, value] of Object.entries(pageAnswers)) {
      const field = extracted.form.fields.find((candidate) => candidate.id === fieldId);
      if (field) appliedAnswers.push({ page: pageNumber, fieldId, label: field.label, value });
    }

    const pageSteps = await fillFields({ page, frame: extracted.frame, fields: extracted.form.fields, answers: pageAnswers });
    steps.push(...pageSteps);
    for (const step of pageSteps) {
      if (!step.ok) issues.push({ level: "warn", code: "fill-failed", message: `${step.label || step.fieldId}: ${step.reason || "value was not applied"}.`, field: step.fieldId });
    }

    const verification = await verifyValues(extracted.frame, extracted.form.fields, pageAnswers);
    issues.push(...verification.issues);
    const validation = await validateAppliedAnswers({ frame: extracted.frame, fields: extracted.form.fields, answers: pageAnswers, client });
    modelValidation = mergeModelValidation(modelValidation, validation, pageNumber);
    issues.push(...modelIssues(validation));

    const challenge = await challengeOnPage(page);
    if (challenge) issues.push({ level: "warn", code: "captcha-present", message: "A CAPTCHA, login, MFA, or verification challenge is present; continue manually." });
    const pageIssues = [...verification.issues, ...resolved.issues, ...(challenge ? [{ code: "captcha-present" }] : [])];
    const pageBlocked = pageIssues.some((issue) => BLOCKING_CODES.has(issue.code)) || pageSteps.some((step) => !step.ok);
    const pageInfo = {
      page: pageNumber,
      url: page.url(),
      title: extracted.form.title,
      fieldCount: extracted.form.fields.length,
      filledCount: pageSteps.filter((step) => step.ok).length,
    };

    if (pageBlocked) {
      stoppedReason = pageIssues.some((issue) => issue.code === "required-empty") ? "required-fields" : "validation";
      pages.push(pageInfo);
      break;
    }

    const continuation = await clickSafeContinuation(page, extracted.frame);
    if (!continuation.clicked) {
      if (continuation.reason !== "final-page") {
        stoppedReason = "navigation-failed";
        issues.push({ level: "warn", code: "navigation-failed", message: `The form's ${continuation.label || "continuation"} control could not be clicked: ${continuation.reason || "unknown error"}.` });
      }
      pages.push(pageInfo);
      break;
    }
    pageInfo.continuation = continuation.label;
    pages.push(pageInfo);
    navigated = true;
  }

  if (pageNumber > MAX_PAGES && pages.at(-1)?.continuation) {
    stoppedReason = "page-limit";
    issues.push({ level: "warn", code: "page-limit", message: `Stopped after ${MAX_PAGES} form pages; review the remaining page manually.` });
  }
  for (const key of Object.keys(rawAnswers)) {
    if (!matchedKeys.has(key)) issues.push({ level: "warn", code: "unknown-field", message: `No unique live form field matched answer key ${key}.`, field: key });
  }

  const finalIssues = uniqueIssues(issues);
  const needsReview = finalIssues.some((issue) => issue.level !== "info") || stoppedReason !== "final-page";
  await page.bringToFront().catch(() => {});
  return {
    tab: { index: tabIndex, url: page.url(), title: await page.title().catch(() => "") },
    fields: lastForm?.form.fields || [],
    appliedAnswers,
    steps,
    pages,
    pagesVisited: pages.length,
    issues: finalIssues,
    navigated,
    verificationRequired: true,
    submitted: false,
    status: needsReview ? "needs_review" : "ready_for_human_verification",
    stoppedReason,
    modelValidation,
  };
}
