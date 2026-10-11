// completion-check: the six patterns of hooks/validate-completion.js
// (removed 2026-10-02), which read a Stop field that does not exist and so
// never fired. The mod reads `last_assistant_message`.

export const PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    re: /pre-existing\s+(issue|bug|problem|error)/i,
    label: "Claiming issues are pre-existing",
  },
  { re: /out\s+of\s+scope/i, label: "Deferring work as out of scope" },
  {
    re: /too\s+many\s+(issues|problems|errors|failures)/i,
    label: "Claiming too many issues to fix",
  },
  {
    re: /(?:separate|future|follow[- ]?up)\s+(?:task|PR|ticket|issue|session)/i,
    label: "Deferring to unrequested follow-ups",
  },
  {
    re: /(?:skip|skipping|skipped)\s+(?:test|lint|check|verification)/i,
    label: "Skipping test/lint failures",
  },
  {
    re: /(?:can't|cannot|unable to)\s+(?:fix|resolve|address)\s+(?:all|every|the remaining)/i,
    label: "Rationalizing incomplete fixes",
  },
];

export function firstMatch(
  text: string,
): { label: string; match: string } | null {
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m) return { label: p.label, match: m[0] };
  }
  return null;
}

export function blockReason(label: string): string {
  return `Rationalization detected: "${label}". Address the incomplete work before stopping.`;
}
