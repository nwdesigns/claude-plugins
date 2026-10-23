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
import {
  capDiff,
  MAX_LINES,
  SECRET_NAME,
  STALE,
  staleMessage,
} from "../lib/collision.ts";
import { redact, redactDeep } from "../lib/redact.ts";
import { resolvePath } from "../lib/util.ts";

// Pure parts of the nwdesigns-mods mods.

describe("status-band", () => {
  const rest: View = { rec: false, percent: 19, edits: 0, checked: false, denied: 0 };
  const all: View = { rec: true, percent: 52, edits: 7, checked: false, denied: 0 };

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
  test("STALE matches Claude Code's refusal, not other errors", () => {
    expect(
      STALE.test(
        "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
      ),
    ).toBe(true);
    expect(STALE.test("File has not been read yet. Read it first.")).toBe(false);
  });

  test("capDiff: short diff unchanged; long diff cut at MAX_LINES or the size cap", () => {
    expect(capDiff("@@ -1 +1 @@\n-a\n+b\n")).toBe("@@ -1 +1 @@\n-a\n+b");
    const long = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join("\n");
    const cut = capDiff(long).split("\n");
    expect(cut).toHaveLength(MAX_LINES + 1);
    expect(cut[cut.length - 1]).toBe("(truncated, read the file)");
    const wide = Array.from({ length: 10 }, () => `+${"x".repeat(1000)}`).join("\n");
    expect(capDiff(wide).split("\n")).toHaveLength(9); // 8 lines fit 8192 chars
  });

  test("staleMessage: path, re-read instruction, native text, diff or placeholder", () => {
    const m = staleMessage("File has been modified since read.", "/p/a.ts", "-a\n+b");
    expect(m).toMatch(/^collision-guard: Read \/p\/a\.ts again, then re-apply/);
    expect(m).toContain("no approval needed");
    expect(m).toContain("Claude Code: File has been modified since read.");
    expect(m.endsWith("--- changed since your last read ---\n-a\n+b")).toBe(true);
    expect(staleMessage("x", "/p/a.ts", undefined)).toContain("(no diff available)");
    // The live refusal arrives wrapped (2.1.309).
    expect(
      staleMessage("<tool_use_error>File has been modified since read.</tool_use_error>", "/p/a.ts", undefined),
    ).toContain("Claude Code: File has been modified since read.\n");
  });

  test("SECRET_NAME: no snapshot for secret-looking files", () => {
    for (const p of ["/p/.env", "/p/.env.local", "/p/db-secret.json", "/k/id.pem"])
      expect(SECRET_NAME.test(p)).toBe(true);
    for (const p of ["/p/src/env.ts", "/p/README.md", "/p/keyboard.ts"])
      expect(SECRET_NAME.test(p)).toBe(false);
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
