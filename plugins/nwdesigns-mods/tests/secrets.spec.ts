import { describe, test, expect } from "bun:test";
import {
  buildMatcher,
  jsonLeaves,
  parseEnv,
  redactDeep,
  redactText,
  RedactLimitError,
} from "../lib/secrets.ts";

// The secret-redact matcher. Every value here is a synthetic canary.

const CANARY = "CANARYsynthetic0123456789zz";
const none = buildMatcher([]);

describe("secret-redact parsing", () => {
  test("parseEnv reads export, quotes and comments as data", () => {
    expect(
      parseEnv(
        `# c\nexport A="x y #z"\nB='q'\nC=plain # note\nD=$(rm -rf /)\nnot a line\n`,
      ),
    ).toEqual([
      { name: "A", value: "x y #z" },
      { name: "B", value: "q" },
      { name: "C", value: "plain" },
      { name: "D", value: "$(rm -rf /)" },
    ]);
  });

  test("jsonLeaves names token leaves by key path and skips UUIDs", () => {
    const text = JSON.stringify({
      tokens: {
        access_token: CANARY,
        account_id: "123e4567-e89b-12d3-a456-426614174000",
      },
    });
    expect([...buildMatcher(jsonLeaves(text)).names.entries()]).toEqual([
      [CANARY, "tokens.access_token"],
    ]);
  });

  test("buildMatcher drops plain values: short, booleans, ports, URLs, paths, emails, model names", () => {
    const m = buildMatcher(
      [
        "short",
        "true",
        "8080",
        "https://api.example.com/v1",
        "/Users/user/projects/x",
        "someone@example.com",
        "claude-opus-5-5",
        "2026-10-07T10:00:00Z",
        CANARY,
      ].map((value, i) => ({ name: `K${i}`, value })),
    );
    expect([...m.names.keys()]).toEqual([CANARY]);
    // A URL with a password is a secret.
    expect(
      buildMatcher([{ name: "DB", value: "postgres://u:pw123456@h/db" }]).names
        .size,
    ).toBe(1);
  });
});

describe("secret-redact exact tier", () => {
  const m = buildMatcher([
    { name: "OPENAI_API_KEY", value: CANARY },
    { name: "LONGER", value: `${CANARY}EXTRA` },
  ]);

  test("a value is replaced by its name, the longer value first", () => {
    expect(redactText(`a ${CANARY} b ${CANARY}EXTRA`, m)).toBe(
      "a [REDACTED:OPENAI_API_KEY] b [REDACTED:LONGER]",
    );
  });

  test("key names and .env.example placeholders stay", () => {
    const t =
      "OPENAI_API_KEY=\nOPENAI_API_KEY=your-key-here\nexport OPENAI_API_KEY";
    expect(redactText(t, m)).toBe(t);
  });
});

describe("secret-redact regex tier", () => {
  // Split literals: the repo's gitleaks gate must not see a whole fixture.
  const KEY = "PRIVATE " + "KEY-----";
  const cases: Array<[string, string]> = [
    [
      `-----BEGIN RSA ${KEY}\nMIIabc\n-----END RSA ${KEY}`,
      "[REDACTED:private-key]",
    ],
    [`-----BEGIN OPENSSH ${KEY}\ncut off`, "[REDACTED:private-key]"],
    [
      [
        "eyJhbGciOiJIUzI1NiJ9",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        "x".repeat(43),
      ].join("."),
      "[REDACTED:jwt]",
    ],
    [`sk-ant-api03-${"A".repeat(30)}`, "[REDACTED:anthropic-key]"],
    [`sk-proj-${"B1".repeat(15)}`, "[REDACTED:openai-key]"],
    [`ghp_${"c".repeat(36)}`, "[REDACTED:github-token]"],
    [`gho_${"c".repeat(36)}`, "[REDACTED:github-token]"],
    [`github_pat_${"d".repeat(40)}`, "[REDACTED:github-token]"],
    [`glpat-${"e".repeat(20)}`, "[REDACTED:gitlab-token]"],
    ["xoxb-1234567890-abcdef", "[REDACTED:slack-token]"],
    ["AKIA" + "ABCDEFGHIJKLMNOP", "[REDACTED:aws-key]"],
    [`Bearer ${"f".repeat(30)}`, "Bearer [REDACTED:bearer]"],
    [
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      "Authorization: Basic [REDACTED:authorization]",
    ],
    [
      `"authorization": "Bearer ${"g".repeat(30)}"`,
      `"authorization": "Bearer [REDACTED:bearer]"`,
    ],
    [
      "https://admin:hunter2pass@example.com/x",
      "https://admin:[REDACTED:url-password]@example.com/x",
    ],
  ];
  for (const [input, out] of cases)
    test(`${out} for ${input.slice(0, 24)}`, () => {
      expect(redactText(input, none)).toBe(out);
    });

  test("false positives stay: git SHAs, UUIDs, base64, code, URLs without a password", () => {
    const keep = [
      "commit 2c1caf0a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b",
      "id 123e4567-e89b-12d3-a456-426614174000",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "const task-runner = disk-usage-report-generator-module;",
      "git@github.com:nwdesigns/repo.git and https://user@example.com/x",
      "Authorization: Bearer $OPENAI_API_KEY",
      "OPENAI_API_KEY=sk-...",
    ];
    for (const t of keep) expect(redactText(t, none)).toBe(t);
  });
});

describe("secret-redact deep", () => {
  const m = buildMatcher([{ name: "K", value: CANARY }]);

  test("nested strings are redacted; media blocks are left whole", () => {
    const image = { type: "image", source: { type: "base64", data: CANARY } };
    const read = { type: "image", file: { base64: CANARY } };
    const r = redactDeep(
      { content: [{ type: "text", text: CANARY }, image], file: read, n: 3 },
      m,
    );
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({
      content: [{ type: "text", text: "[REDACTED:K]" }, image],
      file: read,
      n: 3,
    });
  });

  test("no match hands the same object back", () => {
    const v = { stdout: "ok" };
    expect(redactDeep(v, m)).toEqual({ value: v, changed: false });
    expect(redactDeep(v, m).value).toBe(v);
  });

  test("1 MB of output redacts in under 50 ms", () => {
    const many = buildMatcher(
      Array.from({ length: 60 }, (_, i) => ({
        name: `K${i}`,
        value: `CANARY${i}x${"q".repeat(20)}`,
      })),
    );
    const line = "normal build output line with a path /usr/local/bin and 42\n";
    const big =
      line.repeat(Math.ceil(1_000_000 / line.length)) +
      "CANARY7x" +
      "q".repeat(20);
    redactText(big, many); // warm the regexes
    const t0 = performance.now();
    const out = redactText(big, many);
    const ms = performance.now() - t0;
    expect(out.endsWith("[REDACTED:K7]")).toBe(true);
    expect(ms).toBeLessThan(50);
  });
});

// Regressions from the first review.
describe("secret-redact review fixes", () => {
  const m = buildMatcher([{ name: "K", value: CANARY }]);

  test("P1: a text resource with a mimeType is redacted; binary blobs stay", () => {
    const text = { uri: "file:///x", mimeType: "text/plain", text: CANARY };
    const json = { mimeType: "application/json", data: `{"k":"${CANARY}"}` };
    const blob = { uri: "file:///y", mimeType: "image/png", blob: CANARY };
    const bin = { media_type: "application/pdf", data: CANARY };
    expect(redactDeep([text, json, blob, bin], m).value).toEqual([
      { ...text, text: "[REDACTED:K]" },
      { ...json, data: '{"k":"[REDACTED:K]"}' },
      blob,
      bin,
    ]);
  });

  test("P1: the quadratic JWT input of the review runs in linear time", () => {
    const evil = "eyJabcdefghijk-".repeat(44_000); // 660 KB
    const t0 = performance.now();
    redactText(evil, none);
    redactText(`a://${"a-".repeat(200_000)}://u:${"p".repeat(300_000)}`, none);
    redactText(("-----BEGIN RSA " + "PRIVATE KEY-----").repeat(30_000), none);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("P1: past the size, time or depth limit redactDeep throws (the caller withholds)", () => {
    const limits = { maxChars: 10, ms: 1000, depth: 3 };
    expect(() => redactDeep("x".repeat(11), m, limits)).toThrow(
      RedactLimitError,
    );
    expect(() =>
      redactDeep({ a: { b: { c: { d: "x" } } } }, m, limits),
    ).toThrow(RedactLimitError);
    let t = 0;
    const clock = () => (t += 600);
    expect(() => redactDeep(["a", "b"], m, limits, clock)).toThrow(
      RedactLimitError,
    );
  });

  test("P2: SHAs and UUIDs under identifier names, and numbers, are not exact secrets", () => {
    const sha = "2c1caf0a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const env = parseEnv(
      `BUILD_SHA=${sha}\nSHORT_SHA=2c1caf0a9e8d\nAPP_ID=${uuid}\nCOUNT=123456789012345\nTOKEN=${CANARY}\n`,
    );
    const mm = buildMatcher(env);
    expect([...mm.names.values()]).toEqual(["TOKEN"]);
    expect(redactText(`commit ${sha} app ${uuid} ${CANARY}`, mm)).toBe(
      `commit ${sha} app ${uuid} [REDACTED:TOKEN]`,
    );
  });
});

// Regressions from the second review.
describe("secret-redact second review", () => {
  test("P1: a long credential is consumed whole, never cut with a tail left", () => {
    const jwt = ["eyJ" + "a".repeat(16), "b".repeat(5000), "c".repeat(43)].join(
      ".",
    );
    const url = `https://user:${"Q1".repeat(129)}@example.test/path`;
    const bearer = `Bearer ${"Q".repeat(5000)}`;
    expect(redactText(jwt, none)).toBe("[REDACTED:jwt]");
    expect(redactText(url, none)).toBe(
      "https://user:[REDACTED:url-password]@example.test/path",
    );
    expect(redactText(bearer, none)).toBe("Bearer [REDACTED:bearer]");
    const KEY = "PRIVATE " + "KEY-----";
    const pem = `-----BEGIN RSA ${KEY}\n${"QUJD".repeat(6000)}\n-----END RSA ${KEY}\nafter`;
    expect(redactText(pem, none)).toBe("[REDACTED:private-key]\nafter");
  });

  test("P1: a value under a credential name is matched whatever its shape", () => {
    const hex = "A1b2C3d4".repeat(4);
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const mm = buildMatcher([
      { name: "API_KEY", value: hex },
      { name: "SERVICE_TOKEN", value: uuid },
      { name: "DB_PASS", value: "12345678" },
      { name: "WEBHOOK_SIGNING", value: "f0".repeat(20) }, // neutral name: kept
    ]);
    expect([...mm.names.values()].sort()).toEqual(
      ["API_KEY", "DB_PASS", "SERVICE_TOKEN", "WEBHOOK_SIGNING"].sort(),
    );
    expect(redactText(`${hex} ${uuid}`, mm)).toBe(
      "[REDACTED:API_KEY] [REDACTED:SERVICE_TOKEN]",
    );
  });

  test("P1: parsing and value checks are linear: 240k-character inputs", () => {
    const t0 = performance.now();
    parseEnv(`A=x${" ".repeat(240_000)}y`);
    // Third review P1: a bare CR after a long run of spaces.
    parseEnv(`A=${" ".repeat(240_000)}x\ry`);
    buildMatcher([{ name: "U", value: `a://${":".repeat(240_000)}` }]);
    buildMatcher([{ name: "U", value: `a://b${":".repeat(240_000)}c` }]);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  test("third review: parseEnv keeps its rules without the line regex", () => {
    expect(
      parseEnv("export\tA = 1\r\n  B=two words # c\nC D=x\n=bare\nE=\n"),
    ).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "two words" },
      { name: "E", value: "" },
    ]);
  });

  test("third review P1: a JSON-escaped private key is redacted from BEGIN to END", () => {
    const KEY = "PRIVATE " + "KEY-----";
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(8);
    const json = `{"private_key":"-----BEGIN ${KEY}\\n${body}\\n${body}\\n-----END ${KEY}\\n","x":1}`;
    expect(redactText(json, none)).toBe(
      '{"private_key":"[REDACTED:private-key]\\n","x":1}',
    );
    // No END: up to the closing quote of the JSON string.
    const cut = `{"k":"-----BEGIN ${KEY}\\n${body}\\n${body}","x":1}`;
    expect(redactText(cut, none)).toBe('{"k":"[REDACTED:private-key]","x":1}');
  });

});
