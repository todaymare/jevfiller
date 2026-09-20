const PROTECTED_FIELD_RX = /\b(?:legal(?:ly)? authorized|work authorization|visa|sponsorship|salary|compensation|gender|race|ethnic(?:ity)?|disab(?:ility|led)?|veteran|citizen(?:ship)?|immigration|relocat|consent|privacy|terms|agree|accept|background check)\b/i;
const NORMALIZE_RX = /[^a-z0-9]+/g;

export function compact(value) {
  return String(value ?? "").trim().toLowerCase().replace(NORMALIZE_RX, "");
}

export function answerValue(raw) {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return { value: String(raw), review: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: "", review: false };
  return {
    value: String(raw.value ?? ""),
    review: raw.needs_confirmation === true || raw.needsReview === true,
  };
}

export function resolveField(fields, key) {
  const exact = fields.filter((field) =>
    [field.id, field.nativeId, field.nativeName, field.label]
      .filter(Boolean)
      .some((candidate) => candidate === key),
  );
  if (exact.length === 1) return exact[0];

  const normalized = compact(key);
  if (!normalized) return undefined;
  const matches = fields.filter((field) =>
    [field.id, field.nativeId, field.nativeName, field.label]
      .filter(Boolean)
      .some((candidate) => compact(candidate) === normalized),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function normalizeAnswers(fields, rawAnswers, { ignoreUnknown = false } = {}) {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new Error("answers must be an object keyed by live field id, name, or label");
  }

  const answers = {};
  const issues = [];
  const matchedKeys = new Set();

  for (const [key, raw] of Object.entries(rawAnswers)) {
    const field = resolveField(fields, key);
    if (!field) {
      if (!ignoreUnknown) {
        issues.push({ level: "warn", code: "unknown-field", message: `No unique live form field matched answer key ${key}.`, field: key });
      }
      continue;
    }
    matchedKeys.add(key);
    const { value, review } = answerValue(raw);
    if (review || PROTECTED_FIELD_RX.test(field.label || "")) {
      issues.push({ level: "info", code: "needs-review", message: `${field.label || key} was left for human confirmation.`, field: field.id });
      continue;
    }
    if (!value.trim()) continue;
    answers[field.id] = value;
  }

  return { answers, issues, matchedKeys };
}

export function isProtectedField(label) {
  return PROTECTED_FIELD_RX.test(label || "");
}
