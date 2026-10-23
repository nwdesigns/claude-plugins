import type { EngineInterface, On } from "claude-code";

import { SECRET_NAME, STALE, staleMessage } from "../lib/collision.ts";
import { msg, resolvePath } from "../lib/util.ts";

// collision-guard: no gate and no question. Claude Code itself refuses a Write
// or Edit to a file that changed after this agent last read it. This mod
// replaces that refusal with a text that tells the agent to read the file
// again and re-apply its change, plus a diff of the other writer's change
// (another agent, session or editor), so the agent goes on alone.
// The snapshots only feed the diff: a wrong or missing one gives a wrong or
// missing diff, never a write that Claude Code's own check would refuse.

const SNAP_MAX_BYTES = 256 * 1024;
const KEEP = 50;
// agentId:realPath → the text the agent last read or wrote. Module memory
// only. ponytail: lost on restart, so the first refusal after --resume has no
// diff; persist the snapshots if that matters.
const snaps = new Map<string, string>();

type Target = {
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
  agentId?: unknown;
};

async function realPath(
  $: EngineInterface,
  file: unknown,
): Promise<string | undefined> {
  if (typeof file !== "string") return undefined;
  const home = (await $.env.get("HOME")) ?? "";
  const path = resolvePath(file, home, await $.session.cwd());
  const st = await $.fs.stat(path, { resolve: true }).catch(() => undefined);
  return st?.realPath ?? path;
}

const snapKey = (e: Target, path: string) =>
  `${typeof e.agentId === "string" ? e.agentId : "main"}:${path}`;

// Keep (or drop) the current text of `path` as this agent's last view.
// `secretFiles` = the extraSecretFiles of secret-redact: their old values
// leave its cache when they change, so a diff of them could leak.
async function snapshot(
  $: EngineInterface,
  key: string,
  path: string,
  secretFiles: string[],
) {
  snaps.delete(key); // re-insert: Map order is the LRU order
  if (SECRET_NAME.test(path)) return;
  for (const f of secretFiles) if ((await realPath($, f)) === path) return;
  const st = await $.fs.stat(path);
  if (st.kind !== "file" || st.size > SNAP_MAX_BYTES) return;
  snaps.set(key, String(await $.fs.read(path)));
  if (snaps.size > KEEP) snaps.delete(snaps.keys().next().value!);
}

async function diffSince(
  $: EngineInterface,
  key: string,
  path: string,
): Promise<string | undefined> {
  const old = snaps.get(key);
  if (old === undefined) return undefined;
  const run = await $.process.run(
    ["/usr/bin/diff", "-u", "-L", "your last read", "-L", "now", "-", path],
    { stdin: old, timeoutMs: 2000 },
  );
  // diff: 0 = same, 1 = differences, 2 = trouble.
  return run.exitCode === 1 && run.stdout ? run.stdout : undefined;
}

export function registerCollisionGuard(on: On, secretFiles: string[]): void {
  on("tool.call", { tool: "Read" }, async ($, e, next) => {
    const r = await next(e);
    const t = e as Target;
    if (r.deny !== undefined || r.isError) return r;
    try {
      const path = await realPath($, t.file_path);
      if (!path) return r;
      const key = snapKey(t, path);
      // A partial Read is no whole view: the old snapshot no longer is this
      // agent's last view, so drop it (no diff beats a wrong one).
      if (t.offset !== undefined || t.limit !== undefined) snaps.delete(key);
      else await snapshot($, key, path, secretFiles);
    } catch (err) {
      $.ui.log(`nwdesigns-mods collision-guard: ${msg(err)}`);
    }
    return r;
  });

  on("tool.call", { tool: ["Write", "Edit"] }, async ($, e, next) => {
    const r = await next(e);
    const t = e as Target;
    try {
      const path = await realPath($, t.file_path);
      if (!path) return r;
      const key = snapKey(t, path);
      if (r.deny === undefined && !r.isError) {
        await snapshot($, key, path, secretFiles);
        return r;
      }
      const native =
        r.deny ?? r.text ?? (typeof r.result === "string" ? r.result : "");
      if (!STALE.test(native)) return r;
      const diff = await diffSince($, key, path).catch(() => undefined);
      // The agent reads the file next; that Read takes the new snapshot.
      snaps.delete(key);
      return { deny: staleMessage(native, path, diff) };
    } catch (err) {
      $.ui.log(`nwdesigns-mods collision-guard: ${msg(err)}`);
      return r;
    }
  });
}
