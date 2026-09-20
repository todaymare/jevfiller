import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { observeValues } from "./form.mjs";

function confidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function hasTypeSafe(client) {
  return Boolean(client || process.env.TYPESAFE_API_KEY);
}

export async function resolveFiniteOptions({ fields, answers, client, minConfidence = 0.75 }) {
  const nextAnswers = { ...answers };
  const unresolved = fields.filter((field) =>
    (field.type === "select" || field.type === "radio") && field.options?.length && String(nextAnswers[field.id] || "").trim() &&
    !field.options.some((option) => String(option).trim().toLowerCase() === String(nextAnswers[field.id]).trim().toLowerCase()),
  );
  if (!unresolved.length) return { answers: nextAnswers, issues: [] };

  if (!hasTypeSafe(client)) {
    return {
      answers: Object.fromEntries(Object.entries(nextAnswers).filter(([fieldId]) => !unresolved.some((field) => field.id === fieldId))),
      issues: unresolved.map((field) => ({ level: "warn", code: "option-review", message: `${field.label}: supplied answer does not exactly match a visible option.`, field: field.id })),
    };
  }

  const questions = {};
  for (const field of unresolved) {
    const criteria = { __review__: "No visible option is a safe match; require human review." };
    for (const option of field.options) criteria[option] = option;
    questions[`option:${field.id}`] = choice(
      {
        task: "Choose the exact visible option that best represents the supplied answer.",
        field: { id: field.id, label: field.label, type: field.type, options: field.options },
        suppliedAnswer: nextAnswers[field.id],
      },
      criteria,
    );
  }

  let response;
  try {
    const activeClient = client || new TypeSafeClient();
    response = await activeClient.systemOne({
      state: {
        fields: unresolved.map((field) => ({ id: field.id, label: field.label, type: field.type, options: field.options })),
        suppliedAnswers: Object.fromEntries(unresolved.map((field) => [field.id, nextAnswers[field.id]])),
      },
      questions,
    });
  } catch (error) {
    return {
      answers: Object.fromEntries(Object.entries(nextAnswers).filter(([fieldId]) => !unresolved.some((field) => field.id === fieldId))),
      issues: unresolved.map((field) => ({ level: "warn", code: "option-review", message: `${field.label}: TypeSafe option matching failed${error instanceof Error ? ` (${error.message.slice(0, 120)})` : ""}.`, field: field.id })),
    };
  }

  const issues = [];
  for (const field of unresolved) {
    const selected = response?.answers?.[`option:${field.id}`] || {};
    const selectedOption = field.options.find((option) => option === selected.choice);
    if (!selectedOption || confidence(selected.confidence) < minConfidence) {
      delete nextAnswers[field.id];
      issues.push({ level: "warn", code: "option-review", message: `${field.label}: TypeSafe could not select a visible option with sufficient confidence.`, field: field.id });
    } else {
      nextAnswers[field.id] = selectedOption;
    }
  }
  return { answers: nextAnswers, issues };
}

export async function validateAppliedAnswers({ frame, fields, answers, client, minConfidence = 0.75 }) {
  const observed = await observeValues(frame, fields);
  const entries = fields.filter((field) => field.type !== "file" && String(answers[field.id] || "").trim());
  if (!entries.length) return { status: "skipped", reason: "No non-file answers were applied.", observed, fields: [] };
  if (!hasTypeSafe(client)) return { status: "skipped", reason: "TYPESAFE_API_KEY is not configured.", observed, fields: [] };

  const questions = {};
  for (const field of entries) {
    questions[`field:${field.id}`] = choice(
      {
        task: "Judge whether the observed browser value satisfies the intended answer for this application field.",
        field: { id: field.id, type: field.type, label: field.label, options: field.options || [] },
        intendedAnswer: answers[field.id],
        observedValue: observed[field.id] || "",
      },
      {
        valid: "The observed value satisfies the intended answer.",
        invalid: "The observed value does not satisfy the intended answer.",
        __review__: "The comparison is ambiguous; require human review.",
      },
    );
  }

  let response;
  try {
    const activeClient = client || new TypeSafeClient();
    response = await activeClient.systemOne({
      state: {
        form: { title: "Application form", fields: entries.map((field) => ({ id: field.id, type: field.type, label: field.label, options: field.options || [] })) },
        intendedAnswers: Object.fromEntries(entries.map((field) => [field.id, answers[field.id]])),
        observedValues: Object.fromEntries(entries.map((field) => [field.id, observed[field.id] || ""])),
      },
      questions,
    });
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message.slice(0, 200) : "TypeSafe validation failed.", observed, fields: [] };
  }

  const validationFields = entries.map((field) => {
    const answer = response?.answers?.[`field:${field.id}`] || {};
    const score = confidence(answer.confidence);
    const status = answer.choice === "valid" && score >= minConfidence ? "valid" : answer.choice === "invalid" ? "invalid" : "review";
    return {
      fieldId: field.id,
      label: field.label,
      status,
      confidence: score,
      reason: status === "valid" ? "Observed value satisfies the intended answer." : status === "invalid" ? "Observed value does not satisfy the intended answer." : `TypeSafe validation confidence ${score.toFixed(2)} requires review.`,
    };
  });
  return { status: "validated", observed, fields: validationFields };
}
