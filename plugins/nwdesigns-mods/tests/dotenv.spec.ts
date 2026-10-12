import { describe, expect, test } from "bun:test";
import {
  ensureIgnored,
  isEnvFile,
  stagesEnv,
  upsertEnv,
} from "../lib/dotenv.ts";
import { parseEnv } from "../lib/secrets.ts";

describe("secret-box .env helpers", () => {
  test("upsertEnv replaces the line, export form included, else appends", () => {
    expect(upsertEnv("", "A", "x")).toBe("A=x\n");
    expect(upsertEnv("A=1\nexport B=2\n", "B", "3")).toBe("A=1\nB=3\n");
    expect(upsertEnv("A=1", "C", "2")).toBe("A=1\nC=2\n");
  });

  test("a quoted value reads back the same in parseEnv and in `source .env`", () => {
    expect(upsertEnv("", "P", "a b #c")).toBe("P='a b #c'\n");
    for (const value of ["a b #c", "p$(id)`x`\\n", `it's "x" $HOME \\`]) {
      const text = upsertEnv("", "P", value);
      expect(parseEnv(text)).toEqual([{ name: "P", value }]);
      const sh = Bun.spawnSync([
        "bash",
        "-c",
        'eval "$0"; printf %s "$P"',
        text,
      ]);
      expect(sh.stdout.toString()).toBe(value);
    }
  });

  test("ensureIgnored appends .env once", () => {
    expect(ensureIgnored("node_modules")).toBe("node_modules\n.env\n");
    expect(ensureIgnored("")).toBe(".env\n");
    expect(ensureIgnored("dist\n.env*\n")).toBeNull();
  });

  test("isEnvFile and stagesEnv skip the example files", () => {
    expect(isEnvFile("/r/.env.local")).toBe(true);
    expect(isEnvFile("/r/.env.example")).toBe(false);
    expect(stagesEnv("git add .env")).toBe(true);
    expect(stagesEnv("git add .env.example src/")).toBe(false);
    expect(stagesEnv("cat .env && echo add")).toBe(false);
  });
});
