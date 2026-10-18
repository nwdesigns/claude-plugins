import { atom, read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";

import { duringOwnRun, foreign } from "../lib/collision.ts";
import { msg, resolvePath } from "../lib/util.ts";

// collision-guard: before a Write or Edit, ask when the file changed in the
// last N minutes and the change is not this session's own write (another
// session, another agent, an editor). Advisory, not a lock: mtime does not
// prove who wrote it. A change made during one of this session's Bash runs
// (its subagents included) counts as its own.

const writes = atom({ plugin: "nwdesigns-mods", key: "writes" } as const, {});
const runs = atom(
  { plugin: "nwdesigns-mods", key: "bashRuns" } as const,
  [] as [number, number][],
);
// The permission mode of the last prompt. In bypassPermissions nobody is there
// to answer, and the coordinator gives each worker its own files: pass with a
// log line, as with no surface (2026-10-18).
let mode = "default";
const KEEP = 200;
const KEEP_RUNS = 100;
const SCRATCH = /^\/(private\/)?tmp\//;

type Target = { file_path?: unknown; notebook_path?: unknown };

async function realPath(
  $: EngineInterface,
  e: Target,
): Promise<string | undefined> {
  const file = e.file_path ?? e.notebook_path;
  if (typeof file !== "string") return undefined;
  const home = (await $.env.get("HOME")) ?? "";
  const path = resolvePath(file, home, await $.session.cwd());
  // A new file has no realPath yet: resolve its folder, so the key a later
  // stat gives is the same one.
  const st = await $.fs.stat(path, { resolve: true }).catch(() => undefined);
  if (st?.realPath) return st.realPath;
  const cut = path.lastIndexOf("/");
  const dir = await $.fs
    .stat(path.slice(0, cut) || "/", { resolve: true })
    .catch(() => undefined);
  return dir?.realPath
    ? `${dir.realPath.replace(/\/$/, "")}${path.slice(cut)}`
    : path;
}

export function registerCollisionGuard(on: On, minutes: number): void {
  // Matched (any mode string): plan-effort owns the unmatched hook.
  on("classic.UserPromptSubmit", { permission_mode: /./ }, (_$, e, next) => {
    mode = String(e.permission_mode);
    return next(e);
  });
  // Record every Bash run of this session (subagents included): a file it
  // changes then counts as this session's own.
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const start = await $.clock.now();
    try {
      return await next(e);
    } finally {
      const end = await $.clock.now();
      await update($, runs, (r) =>
        [...(r ?? []), [start, end] as [number, number]].slice(-KEEP_RUNS),
      ).catch((err) => $.ui.log(`nwdesigns-mods collision-guard: ${msg(err)}`));
    }
  });
  on(
    "tool.call",
    { tool: ["Write", "Edit", "NotebookEdit"] },
    async ($, e, next) => {
      const t = e as Target;
      let key: string | undefined;
      try {
        key = await realPath($, t);
        if (key && !SCRATCH.test(key)) {
          const st = await $.fs.stat(key);
          const now = await $.clock.now();
          const own = (await read($, writes))[key];
          const n = Math.max(0, Math.round((now - st.mtimeMs) / 60_000));
          const name = key.slice(key.lastIndexOf("/") + 1);
          const isForeign =
            foreign(st.mtimeMs, own, now, minutes * 60_000) &&
            !duringOwnRun(st.mtimeMs, await read($, runs));
          if (
            isForeign &&
            (mode === "bypassPermissions" ||
              (await $.session.surfaces()).length === 0)
          ) {
            $.ui.log(
              `nwdesigns-mods collision-guard: ${name} changed ${n} min ago; no one to ask, pass`,
            );
          } else if (isForeign) {
            const answer = await $.ui
              .ask(
                `${name} changed ${n} min ago, not by this session. Edit it anyway?`,
                ["Edit anyway", "Cancel"],
              )
              // Dismissed by the person: a deny, as Cancel.
              .catch(() => "Cancel");
            if (answer !== "Edit anyway")
              return {
                deny: `collision-guard: ${name} changed ${n} min ago by another writer (another session or an editor). The user cancelled. Ask the user how to proceed.`,
              };
          }
        }
      } catch (err) {
        // ENOENT is a new file; any other stat error passes with a log line.
        if (!/ENOENT/.test(msg(err)))
          $.ui.log(`nwdesigns-mods collision-guard: ${msg(err)}`);
      }
      const r = await next(e);
      if (key && r.deny === undefined && !r.isError) {
        try {
          const { mtimeMs } = await $.fs.stat(key);
          await update($, writes, (w) =>
            Object.fromEntries(
              Object.entries({ ...w, [key!]: mtimeMs })
                .sort(([, a], [, b]) => b - a)
                .slice(0, KEEP),
            ),
          );
        } catch (err) {
          $.ui.log(`nwdesigns-mods collision-guard: ${msg(err)}`);
        }
      }
      return r;
    },
  );
}
