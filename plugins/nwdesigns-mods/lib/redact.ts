// recording: pure masks for the screen. CAUTION: regex masks miss some values;
// this hides text on screen only and is not a security boundary.

const MASKS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]"],
  [
    /\b(sk-[\w-]{16,}|ghp_\w{20,}|github_pat_\w{20,}|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    "[key]",
  ],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, "[iban]"],
  [/[$€£] ?\d[\d.,]*|\d[\d.,]* ?[$€£]/g, "[amount]"],
  // 32+ hex or 40+ base64 characters in a row: tokens, hashes, keys. No `/`
  // in the base64 class, so a long path stays readable.
  [/\b[A-Fa-f0-9]{32,}\b|[A-Za-z0-9+]{40,}={0,2}/g, "[key]"],
];

export function redact(text: string): string {
  return MASKS.reduce((t, [re, to]) => t.replace(re, to), text);
}

// A new value: strings redacted, arrays and plain objects rebuilt, the rest
// copied. Never mutates its input (the render props are frozen).
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v)]),
    );
  return value;
}
