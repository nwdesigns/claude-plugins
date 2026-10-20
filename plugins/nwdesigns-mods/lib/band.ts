// status-band: pure parts. The band is an attention list, empty at rest:
// items(view) names what needs the person, layout() fits it to the band width.

// A Bash command that runs the project checks counts as a check.
export const CHECK_COMMAND =
  /\bbun (test|run (typecheck|lint))\b|\bnpm (test|run (lint|typecheck))\b|\bcomposer (test|lint)\b|\bvendor\/bin\/phpunit\b|\bphpcs\b/;

// A Bash command that pushes clears `checked` (a hint, not the repo truth).
export const PUSH_COMMAND = /\bgit\b[^;&|]*\bpush\b/;

export type ButtonKey = "verify" | "push" | "compact" | "rec";
export type Button = { key: ButtonKey; label: string };
// A digit by position: from an empty prompt only a bare digit presses a band
// Button (a letter works only while the band holds the focus). Digits 1-3;
// other band mods keep clear of them.
export type Placed = Button & { hotkey: string };
export type Tone = "bad" | "warn" | "info";
export type Item = {
  key: string;
  tone: Tone;
  long: string;
  short: string;
  buttons: Button[];
};

// What items() reads: plain values, so the test needs no engine.
export type View = {
  rec: boolean;
  percent: number; // context fill
  edits: number;
  checked: boolean;
  denied: number; // main-loop tool calls denied in the running turn
};

const B = {
  verify: { key: "verify", label: "verify" },
  push: { key: "push", label: "push" },
  compact: { key: "compact", label: "compact" },
  rec: { key: "rec", label: "stop rec" },
} as const satisfies Record<ButtonKey, Button>;

// Priority order: the order of the text and of the buttons.
export function items(v: View): Item[] {
  const out: Item[] = [];
  const add = (
    on: boolean,
    key: string,
    tone: Tone,
    long: string,
    short: string,
    buttons: Button[] = [],
  ) => on && out.push({ key, tone, long, short, buttons });
  add(v.rec, "rec", "bad", "● REC, screen redaction on", "● REC", [B.rec]);
  add(
    v.percent >= 50,
    "context",
    "warn",
    `context ${v.percent}%, time to compact`,
    `ctx ${v.percent}%`,
    [B.compact],
  );
  const e = v.edits;
  add(
    e > 0,
    "edits",
    "warn",
    `${e} edit${e === 1 ? "" : "s"} since the last check`,
    `${e} edit${e === 1 ? "" : "s"}`,
    [B.verify],
  );
  const d = v.denied;
  add(
    d > 0,
    "denied",
    "warn",
    `${d} call${d === 1 ? "" : "s"} denied this turn`,
    `${d} denied`,
  );
  add(
    v.checked && e === 0,
    "checked",
    "info",
    "checked, ready to push",
    "checked",
    [B.push],
  );
  return out;
}

export type Layout = {
  text: string;
  tone: Tone;
  buttons: Placed[];
  wrap: boolean; // below 50 columns the buttons take a row of their own
};

const RANK: Record<Tone, number> = { info: 0, warn: 1, bad: 2 };

export function layout(
  list: Item[],
  bodyColumns: number,
  isWorking: boolean,
): Layout | null {
  const shown = isWorking ? list.filter((i) => i.tone === "bad") : list;
  if (shown.length === 0) return null;
  return {
    text: shown.map((i) => (bodyColumns >= 80 ? i.long : i.short)).join(" · "),
    tone: shown.reduce<Tone>(
      (t, i) => (RANK[i.tone] > RANK[t] ? i.tone : t),
      "info",
    ),
    buttons: shown
      .flatMap((i) => i.buttons)
      .slice(0, 3)
      .map((b, n) => ({ ...b, hotkey: String(n + 1) })),
    wrap: bodyColumns < 50,
  };
}
