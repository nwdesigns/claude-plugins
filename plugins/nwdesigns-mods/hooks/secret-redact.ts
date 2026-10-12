import type { EngineInterface, On, ToolCallResult } from "claude-code";

import {
  buildMatcher,
  handedCount,
  jsonLeaves,
  parseEnv,
  redactDeep,
  WITHHELD,
  type Matcher,
  type Named,
} from "../lib/secrets.ts";
import { resolvePath } from "../lib/util.ts";

// secret-redact: every tool result is redacted before core records it in the
// transcript and maps it for the model. A hook's own `{ result }` is what core
// stores. Mods fail open on a throw or an overrun, so every error after the
// tool ran is caught here and answered with the result withheld.
//
// The values live in this module's memory only, never in $.state or $.store.
// Not covered: the tool input (a secret the model writes into a command),
// thinking, the screen before this hook, and telemetry.

type Cached = { mtimeMs: number; entries: Named[] };
type Source = { path: string; kind: "env" | "json"; required: boolean };
const files = new Map<string, Cached>();
let built: { key: string; matcher: Matcher } | undefined;

// A configured source that cannot load: the result is withheld.
class SourceError extends Error {}

// The project .env files are optional. Each extraSecretFiles path is
// required: a `.json` file is read as JSON, any other as KEY=value lines.
function sources(home: string, cwd: string, extra: string[]): Source[] {
  return [
    ...[".env", ".env.local", ".env.production"].map((f) => ({
      path: `${cwd}/${f}`,
      kind: "env" as const,
      required: false,
    })),
    ...extra.map((f) => ({
      path: resolvePath(f, home, cwd),
      kind: f.endsWith(".json") ? ("json" as const) : ("env" as const),
      required: true,
    })),
  ];
}

// Re-read a file only when its mtime changed; rebuild only when a file did.
// Each file on its own: one that fails to stat, read or parse keeps its last
// good values and is logged by path only; the others still count. An optional
// file that is missing drops its values. A required file with no good values
// (missing, unreadable or malformed) throws SourceError.
async function matcher($: EngineInterface, extra: string[]): Promise<Matcher> {
  const home = (await $.env.get("HOME")) ?? "";
  const cwd = await $.session.cwd();
  const keys: string[] = [];
  const entries: Named[] = [];
  for (const { path, kind, required } of sources(home, cwd, extra)) {
    let c = files.get(path);
    try {
      const st = await $.fs.stat(path).catch((err: unknown) => {
        if (!required && /ENOENT/.test(String(err))) return undefined;
        throw err;
      });
      if (!st || st.kind !== "file") {
        if (required) throw new Error("not a file");
        files.delete(path);
        continue;
      }
      if (c?.mtimeMs !== st.mtimeMs) {
        const text = String(await $.fs.read(path));
        c = {
          mtimeMs: st.mtimeMs,
          entries: kind === "env" ? parseEnv(text) : jsonLeaves(text),
        };
        files.set(path, c);
      }
    } catch {
      if (required && !c) throw new SourceError(path);
      $.ui.log(
        `nwdesigns-mods secret-redact: ${path} unreadable, its last values kept`,
      );
    }
    if (!c) continue;
    keys.push(`${path}@${c.mtimeMs}`);
    entries.push(...c.entries);
  }
  const key = `${keys.join("\n")}\n${handedCount()}`;
  if (built?.key !== key) built = { key, matcher: buildMatcher(entries) };
  return built.matcher;
}

// Never the error's message: it may quote the value that failed.
const kind = (err: unknown) =>
  err instanceof Error ? err.constructor.name : typeof err;

// A large Bash output is spilled by the tool itself, before this hook, to
// <session>/tool-results/<id>.txt (`persistedOutputPath`). Redact that file
// in place; one that cannot be read back (over 4 MiB) is withheld.
async function scrubSpill(
  $: EngineInterface,
  result: unknown,
  m: Matcher,
): Promise<void> {
  const path = (result as { persistedOutputPath?: unknown } | null)
    ?.persistedOutputPath;
  if (typeof path !== "string") return;
  try {
    const text = String(await $.fs.read(path));
    const red = redactDeep(text, m);
    if (red.changed) await $.fs.write(path, red.value as string);
  } catch (err) {
    // Unreadable, over a limit, or the rewrite failed: blank it, else delete
    // it. If both fail, say so and throw: the result is withheld.
    $.ui.log(
      `nwdesigns-mods secret-redact: spill file withheld (${kind(err)})`,
    );
    const blanked = await $.fs.write(path, WITHHELD).then(
      () => true,
      () => false,
    );
    if (blanked) return;
    const run = await $.process
      .run(["/bin/unlink", path])
      .catch(() => undefined);
    if (run?.exitCode === 0) return;
    $.ui.log(`nwdesigns-mods secret-redact: spill file NOT removed: ${path}`);
    throw new Error("spill file not removed");
  }
}

// The answer when redaction cannot finish: a deny with the withheld text. A
// deny needs no tool schema, so core never rejects it (a rebuilt `result`
// can break one: Read's `type: "text"`). The model reads it as an error. A
// deny text that could not be redacted is withheld too.
const withhold = (): ToolCallResult => ({ deny: WITHHELD });

export function registerSecretRedact(on: On, extra: string[]): void {
  on("tool.call", async ($, e, next) => {
    const r = await next(e);
    try {
      let m: Matcher;
      try {
        m = await matcher($, extra);
      } catch (err) {
        // A configured source failed with no good values: fail closed.
        if (err instanceof SourceError || extra.length > 0) throw err;
        // Only the optional project files: the regex tier still runs.
        $.ui.log(
          `nwdesigns-mods secret-redact: matcher load failed (${kind(err)})`,
        );
        m = buildMatcher([]);
      }
      if (r.deny !== undefined) {
        // A deny text (another mod's, or the tool's refusal) is redacted too.
        const red = redactDeep(r.deny, m);
        return red.changed ? { ...r, deny: red.value as string } : r;
      }
      await scrubSpill($, r.result, m);
      if (r.isError) {
        // Core validates a hook's error answer against the tool's output
        // schema, which an error text never matches (live check, 2.1.293). A
        // deny reaches the model as the same error result, its text redacted.
        const text = r.text ?? (typeof r.result === "string" ? r.result : "");
        const red = redactDeep(text, m);
        const raw = redactDeep(r.result, m).changed;
        return red.changed || raw ? { deny: red.value as string } : r;
      }
      const res = redactDeep(r.result, m);
      const ctx = redactDeep(r.context, m);
      if (!res.changed && !ctx.changed) return r;
      const context = ctx.value as readonly string[] | undefined;
      return { result: res.value, context } as never;
    } catch (err) {
      // A RedactLimitError (size, time, depth) lands here too.
      $.ui.log(
        `nwdesigns-mods secret-redact: redaction failed (${kind(err)}), result withheld`,
      );
      return withhold();
    }
  })
    // Past the engine's 10 s budget the hook would be skipped and the raw
    // result stored: withhold instead. `next` replays, the tool does not rerun.
    .catch(async (_$, e, next) => (await next(e), withhold()));
}
