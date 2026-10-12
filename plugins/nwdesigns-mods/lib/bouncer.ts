// prompt-bouncer: the pure parts. No runtime imports.
// Ported from ray-amjad/claude-code-mods b75f32f, plugins/prompt-bouncer/hooks/register.js
// (MIT, Copyright (c) 2026 Ray Amjad). Changes: project mode only, the last
// answer in the prompt, Italian or English.

export type Verdict =
  { pass: true } | { pass: false; reason: string; suggestion?: string };

export const SYSTEM =
  "You are a gatekeeper for a coding agent. Reply with JSON only, no prose.";

// A slash command passes, and so does every prompt in a repo with no glossary.
export function shouldCheck(prompt: string, hasGlossary: boolean): boolean {
  const text = prompt.trim();
  return hasGlossary && text !== "" && !text.startsWith("/");
}

// The docs block is the same on every prompt: the cached prefix.
export function buildPrompt(
  docs: string,
  lastAnswer: string,
  prompt: string,
): Array<{ text: string; cache?: true }> {
  const before = lastAnswer
    ? `The agent's last answer, which the prompt replies to (a short reply such as "yes" or "1" picks from it):\n<answer>\n${lastAnswer}\n</answer>\n\n`
    : 'This is the FIRST message of a new session (so "it" or "that" points at nothing).\n\n';
  return [
    {
      text: `PROJECT DOCS (the project's own language):\n\n${docs}`,
      cache: true,
    },
    {
      text:
        before +
        `A developer is about to send this prompt to a coding agent:\n\n<prompt>\n${prompt}\n</prompt>\n\n` +
        "Bounce it if EITHER is true: (1) it uses a loose word where the docs define a precise term " +
        '(any word in the glossary\'s "Not" column, or a close paraphrase of one, always bounces), or ' +
        "(2) the agent would have to guess what it refers to, because it names no file, feature or component. " +
        "A prompt that already names a project term or a file passes, even if other words in it are casual. " +
        'Ordinary verbs and words like "switch", "change" or "update" are not loose terms. ' +
        "The prompt can be Italian or English; write the suggestion in the prompt's language.\n\n" +
        'Reply {"pass": true} or {"pass": false, "reason": "<one short sentence>", "suggestion": "<under 25 words: the prompt rewritten with the project\'s term; if it could mean two things, ask which one>"}',
    },
  ];
}

// Anything but a clear {pass:false} passes: the bouncer never locks you out.
export function parseVerdict(text: string): Verdict {
  try {
    const json = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    ) as { pass?: unknown; reason?: unknown; suggestion?: unknown };
    if (json.pass !== false) return { pass: true };
    const reason =
      typeof json.reason === "string" && json.reason
        ? json.reason
        : "too vague for this project";
    return typeof json.suggestion === "string" && json.suggestion
      ? { pass: false, reason, suggestion: json.suggestion }
      : { pass: false, reason };
  } catch {
    return { pass: true };
  }
}
