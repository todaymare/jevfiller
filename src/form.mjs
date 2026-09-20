import { compact } from "./contract.mjs";

export async function extractForm(ctx) {
  const data = await ctx.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
    const isGeneric = (value) => /^(start typing|select\b|choose|search\b|type\b|--|please select|e\.?g\.?)/i.test(value.trim());
    const usable = (value) => {
      const text = (value || "").trim();
      return text && !isUuid(text) && !isGeneric(text) ? text : "";
    };
    const pure = (node) => {
      if (!node) return "";
      const clone = node.cloneNode(true);
      clone.querySelectorAll?.("input, select, textarea, option, button, [role=option], [class*='menu' i]").forEach((child) => child.remove());
      return clean(clone.textContent);
    };
    const fieldGroup = (element) => element.closest(
      "[class*='field-entry' i], [class*='fieldEntry' i], [class*='form-group' i], [class*='question' i], [class*='field__' i], [class*='__field' i], fieldset, [class*='field' i]",
    );
    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (usable(aria)) return aria;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
        if (usable(text)) return text;
      }
      const id = element.id;
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label && usable(pure(label))) return pure(label);
      }
      const parentLabel = element.closest("label");
      if (parentLabel && usable(pure(parentLabel))) return pure(parentLabel);
      const group = fieldGroup(element);
      if (group) {
        const label = group.querySelector("label, legend, [class*='question-title' i], [class*='heading' i], [class*='label' i], [class*='title' i]");
        if (label && usable(pure(label))) return pure(label);
      }
      let current = element.parentElement;
      for (let i = 0; i < 4 && current; i++, current = current.parentElement) {
        const label = current.querySelector("label, legend, [class*='label' i], [class*='title' i], h3, h4, h5");
        if (label && usable(pure(label))) return pure(label);
      }
      return usable(element.getAttribute("placeholder")) || usable(element.getAttribute("name"));
    };
    const groupLabel = (firstRadio, options) => {
      const group = firstRadio.closest("[role=radiogroup], fieldset");
      if (group) {
        const aria = group.getAttribute("aria-label");
        if (aria) return aria;
        const labelledBy = group.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
          if (text.trim()) return text;
        }
        const legend = group.querySelector("legend");
        if (legend?.textContent?.trim()) return legend.textContent;
      }
      const optionSet = new Set(options.map((option) => option.toLowerCase()));
      const container = fieldGroup(firstRadio) || firstRadio.parentElement?.parentElement || firstRadio.parentElement;
      if (container) {
        const candidates = container.querySelectorAll("label, legend, h1, h2, h3, h4, h5, h6, [class*='question-title' i], [class*='heading' i], [class*='label' i], [class*='title' i], [class*='question' i]");
        for (const candidate of candidates) {
          const text = pure(candidate);
          if (text && text.length > 2 && text.length < 160 && !optionSet.has(text.toLowerCase()) && !isUuid(text) && !isGeneric(text)) return text;
        }
      }
      return "";
    };

    const fields = [];
    const seenRadio = new Set();
    let number = 0;
    for (const element of Array.from(document.querySelectorAll("input, textarea, select"))) {
      const tag = element.tagName.toLowerCase();
      const inputType = (element.type || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "image", "reset"].includes(inputType)) continue;
      const rect = element.getBoundingClientRect();
      if (element.offsetParent === null && inputType !== "radio" && inputType !== "checkbox" && !(rect.width > 1 && rect.height > 1)) continue;
      if (element.closest("[class*='autofill' i]")) continue;

      const reactSelect = element.closest("[class*='select__'], .select-shell");
      const combobox = element.getAttribute("role") === "combobox";
      if (reactSelect && tag === "input" && !combobox) continue;

      const required = Boolean(element.required || element.getAttribute("aria-required") === "true");
      const nativeId = element.id || undefined;
      const nativeName = element.name || undefined;
      const fieldId = `jev${number++}`;

      if (combobox) {
        element.setAttribute("data-jev-field", fieldId);
        fields.push({ id: fieldId, type: "select", combobox: true, label: clean(labelFor(element)), required, options: [], nativeId, nativeName });
        continue;
      }

      if (inputType === "radio") {
        const name = element.name;
        if (name && seenRadio.has(name)) {
          number--;
          continue;
        }
        if (name) seenRadio.add(name);
        const group = name ? Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`)) : [element];
        const options = group.map((radio) => clean(labelFor(radio) || radio.value)).filter(Boolean);
        group.forEach((radio, index) => {
          radio.setAttribute("data-jev-field", fieldId);
          radio.setAttribute("data-jev-option", options[index] || String(index));
        });
        fields.push({ id: fieldId, type: "radio", label: clean(groupLabel(element, options)) || name || "Radio choice", required, options });
        continue;
      }

      element.setAttribute("data-jev-field", fieldId);
      if (tag === "select") {
        const options = Array.from(element.options).map((option) => clean(option.textContent)).filter((option) => option && !/^(select|choose|--)/i.test(option));
        fields.push({ id: fieldId, type: "select", label: clean(labelFor(element)), required, options, nativeId, nativeName });
        continue;
      }
      const type = tag === "textarea" ? "textarea" : ["email", "tel", "url", "number", "date", "checkbox", "file"].includes(inputType) ? inputType : "text";
      fields.push({
        id: fieldId,
        type,
        label: clean(labelFor(element)),
        required,
        maxLength: element.maxLength > 0 ? element.maxLength : undefined,
        value: element.value || undefined,
        nativeId,
        nativeName,
      });
    }
    return { title: document.title, fields };
  });

  return { title: data.title || "", url: ctx.url(), fields: data.fields };
}

export async function extractApplicationForm(page) {
  let best = { frame: page.mainFrame(), form: { title: "", url: page.url(), fields: [] } };
  for (const frame of page.frames()) {
    try {
      const form = await extractForm(frame);
      if (form.fields.length > best.form.fields.length) best = { frame, form };
    } catch {
      // Detached and cross-origin frames are not actionable form surfaces.
    }
  }
  if (!best.form.title) best.form.title = await page.title().catch(() => "");
  return best;
}

export async function observeValues(frame, fields) {
  return frame.evaluate((metadata) => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const values = {};
    for (const field of metadata) {
      const controls = Array.from(document.querySelectorAll(`[data-jev-field="${CSS.escape(field.id)}"]`));
      if (!controls.length) continue;
      if (field.type === "radio") {
        const selected = controls.find((control) => control.checked);
        values[field.id] = selected?.getAttribute("data-jev-option") || selected?.value || "";
      } else if (field.type === "checkbox") {
        values[field.id] = controls[0].checked ? "true" : "false";
      } else if (field.type === "file") {
        values[field.id] = controls[0].files?.length ? "attached" : "";
      } else if (field.type === "select") {
        if (field.combobox) {
          const shell = controls[0].closest("[class*='select-shell' i], [class*='select__container' i], [class*='select__control' i], [class*='value-container' i]") || controls[0].parentElement;
          const selected = shell?.querySelector(".select__single-value, [class*='single-value' i], [class*='singleValue' i], [class*='multi-value' i]");
          values[field.id] = clean(selected?.textContent || controls[0].value || controls[0].textContent);
        } else {
          values[field.id] = clean(controls[0].selectedOptions?.[0]?.textContent || controls[0].value);
        }
      } else {
        values[field.id] = clean(controls[0].value || controls[0].textContent);
      }
    }
    return values;
  }, fields.map(({ id, type, combobox }) => ({ id, type, combobox })));
}

export function valuesMatch(field, expected, observed) {
  const wanted = String(expected ?? "").trim();
  const actual = String(observed ?? "").trim();
  if (field.type === "checkbox") {
    return ["true", "1", "yes", "on", "checked"].includes(wanted.toLowerCase()) === (actual === "true");
  }
  if (field.type === "radio" || field.type === "select") return compact(wanted) === compact(actual);
  return wanted === actual;
}

export async function verifyValues(frame, fields, answers) {
  const observed = await observeValues(frame, fields);
  const issues = [];
  for (const [fieldId, expected] of Object.entries(answers)) {
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field || field.type === "file") continue;
    if (!valuesMatch(field, expected, observed[fieldId])) {
      issues.push({ level: "warn", code: "fill-mismatch", message: `${field.label || fieldId} did not retain the intended value.`, field: fieldId });
    }
  }
  for (const field of fields) {
    if (field.required && field.type !== "file" && !String(observed[field.id] || "").trim()) {
      issues.push({ level: "warn", code: "required-empty", message: `${field.label || field.id} is required and remains empty.`, field: field.id });
    }
  }
  return { observed, issues };
}
