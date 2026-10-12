import { describe, expect, test } from "bun:test";
import { buildPrompt, parseVerdict, shouldCheck } from "../lib/bouncer.ts";

describe("prompt-bouncer", () => {
  test("shouldCheck skips slash commands, empty prompts and repos without a glossary", () => {
    expect(shouldCheck("aggiorna il deck PPC", true)).toBe(true);
    expect(shouldCheck("  /compact", true)).toBe(false);
    expect(shouldCheck("   ", true)).toBe(false);
    expect(shouldCheck("fix the thing", false)).toBe(false);
  });

  test("parseVerdict reads a bounce and passes anything else", () => {
    expect(
      parseVerdict(
        'ok: {"pass": false, "reason": "PPC is loose", "suggestion": "usa Google Ads"}',
      ),
    ).toEqual({
      pass: false,
      reason: "PPC is loose",
      suggestion: "usa Google Ads",
    });
    expect(parseVerdict('{"pass": false}')).toEqual({
      pass: false,
      reason: "too vague for this project",
    });
    expect(parseVerdict('{"pass": true}')).toEqual({ pass: true });
    expect(parseVerdict("no json here")).toEqual({ pass: true });
  });

  test("buildPrompt caches the docs and carries the last answer", () => {
    const [docs, ask] = buildPrompt("GLOSSARY", "1. A\n2. B", "1");
    expect(docs).toEqual({
      text: expect.stringContaining("GLOSSARY"),
      cache: true,
    });
    expect(ask!.text).toContain("<answer>\n1. A\n2. B\n</answer>");
    expect(ask!.text).toContain("<prompt>\n1\n</prompt>");
    expect(buildPrompt("G", "", "x")[1]!.text).toContain("FIRST message");
  });
});
