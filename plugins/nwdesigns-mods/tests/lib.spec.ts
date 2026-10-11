import { describe, test, expect } from "bun:test";
import { raise } from "../lib/effort.ts";
import { firstMatch } from "../lib/completion.ts";
import {
  CHECK_COMMAND,
  items,
  layout,
  PUSH_COMMAND,
  type View,
} from "../lib/band.ts";
import { duringOwnRun, foreign } from "../lib/collision.ts";
import { redact, redactDeep } from "../lib/redact.ts";
import { resolvePath } from "../lib/util.ts";

// Pure parts of the nwdesigns-mods mods.

describe("status-band", () => {
  const rest: View = { rec: false, percent: 19, edits: 0, checked: false };
  const all: View = { rec: true, percent: 52, edits: 7, checked: false };

  test("at rest the band is empty", () => {
    expect(layout(items(rest), 120, false)).toBeNull();
  });

  test("all items: long text at 120, short at 70, buttons on their own row below 50", () => {
    const wide = layout(items(all), 120, false)!;
    expect(wide.text).toBe(
      "● REC, screen redaction on · context 52%, time to compact · 7 edits since the last check",
    );
    expect(wide.tone).toBe("bad");
    expect(wide.buttons.map((b) => `${b.hotkey}: ${b.label}`)).toEqual([
      "1: stop rec",
      "2: compact",
      "3: verify",
    ]);
    expect(layout(items(all), 70, false)!.text).toBe(
      "● REC · ctx 52% · 7 edits",
    );
    expect(layout(items(all), 40, false)!.wrap).toBe(true);
    expect(layout(items(all), 70, false)!.wrap).toBe(false);
  });

  test("while working only bad items show; a passed check offers push", () => {
    expect(layout(items(all), 120, true)!.text).toBe(
      "● REC, screen redaction on",
    );
    const ok = layout(items({ ...rest, checked: true }), 120, false)!;
    expect([ok.text, ok.tone, ok.buttons[0]?.key]).toEqual([
      "checked, ready to push",
      "info",
      "push",
    ]);
  });

  test("the check commands that reset the count", () => {
    for (const c of [
      "bun test",
      "cd x && bun run typecheck",
      "bun run lint",
      "npm test",
      "npm run lint",
      "composer test",
      "vendor/bin/phpunit --filter X",
      "phpcs --standard=WordPress .",
    ])
      expect(CHECK_COMMAND.test(c)).toBe(true);
    for (const c of [
      "bun install",
      "npm install",
      "bun run build",
      "composer install",
    ])
      expect(CHECK_COMMAND.test(c)).toBe(false);
    expect(PUSH_COMMAND.test("git push -u origin x")).toBe(true);
    expect(PUSH_COMMAND.test("git stash; echo push")).toBe(false);
  });
});

describe("collision-guard", () => {
  const MIN = 60_000;
  const now = 100 * MIN;

  test("in the window and not this session's write → foreign", () => {
    expect(foreign(now - 3 * MIN, undefined, now, 10 * MIN)).toBe(true);
    expect(foreign(now - 3 * MIN, now - 5 * MIN, now, 10 * MIN)).toBe(true);
  });

  test("own write, formatter grace, outside the window → not foreign", () => {
    expect(foreign(now - 3 * MIN, now - 3 * MIN, now, 10 * MIN)).toBe(false);
    expect(foreign(now - 3 * MIN + 5000, now - 3 * MIN, now, 10 * MIN)).toBe(
      false,
    );
    expect(foreign(now - 11 * MIN, undefined, now, 10 * MIN)).toBe(false);
  });

  test("a change during this session's Bash run (or its grace) is own", () => {
    const runs = [[now - 4 * MIN, now - 4 * MIN + 2000]] as [number, number][];
    expect(duringOwnRun(now - 4 * MIN + 1000, runs)).toBe(true);
    expect(duringOwnRun(now - 4 * MIN + 2000 + 9000, runs)).toBe(true);
    expect(duringOwnRun(now - 3 * MIN, runs)).toBe(false);
    expect(duringOwnRun(now - 3 * MIN, [])).toBe(false);
  });

  test("resolvePath: ~ and cwd-relative paths", () => {
    expect(resolvePath("~/a.md", "/h", "/srv")).toBe("/h/a.md");
    expect(resolvePath("a.md", "/h", "/srv/")).toBe("/srv/a.md");
    expect(resolvePath("/x/a.md", "/h", "/srv")).toBe("/x/a.md");
  });
});

describe("recording", () => {
  test("masks emails, keys, IBANs and amounts", () => {
    expect(
      redact(
        "mail a.b@example.com IT60 X054 2811 1010 0000 0123 456 paid €1.200,50 and $40",
      ),
    ).toBe("mail [email] [iban] paid [amount] and [amount]");
    expect(redact("hash 0123456789abcdef0123456789abcdef")).toBe("hash [key]");
  });

  test("no false positive on $HOME, a 31-char hex or a long path", () => {
    const keep =
      "cd $HOME; id 0123456789abcdef0123456789abcde /home/dev/projects/site/wp-content/themes";
    expect(redact(keep)).toBe(keep);
  });

  test("redactDeep builds a new value and leaves its input unchanged", () => {
    const input = { stdout: "to a@example.com", list: ["$5"], n: 1 };
    const copy = structuredClone(input);
    expect(redactDeep(input)).toEqual({
      stdout: "to [email]",
      list: ["[amount]"],
      n: 1,
    });
    expect(input).toEqual(copy);
  });
});

describe("completion-check", () => {
  test("each of the six patterns matches, a clean message does not", () => {
    const hits = [
      "a pre-existing bug in the parser",
      "that is out of scope",
      "there are too many errors to fix",
      "I will open a follow-up PR",
      "skipping lint for now",
      "I cannot fix all of them",
    ].map((t) => firstMatch(t)?.label);
    expect(new Set(hits).size).toBe(6);
    expect(firstMatch("All 12 tests pass and lint is clean.")).toBeNull();
  });
});

describe("plan-effort", () => {
  test("xhigh only in plan mode, on the main loop, without an explicit /effort", () => {
    const plan = { mode: "plan", userSet: false };
    expect(raise(plan, undefined, "medium")).toBe(true);
    expect(raise(plan, "agent-1", "medium")).toBe(false);
    expect(raise({ ...plan, userSet: true }, undefined, "medium")).toBe(false);
    expect(raise({ ...plan, mode: "default" }, undefined, "medium")).toBe(
      false,
    );
    expect(raise(plan, undefined, "max")).toBe(false);
    expect(raise(null, undefined, "medium")).toBe(false);
  });
});
