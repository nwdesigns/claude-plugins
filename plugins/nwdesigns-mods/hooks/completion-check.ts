import type { EngineInterface, On } from "claude-code";

import { blockReason, firstMatch } from "../lib/completion.ts";
import { msg } from "../lib/util.ts";

// completion-check: replaces hooks/validate-completion.js. On Stop, the
// model's last message is checked for six rationalization patterns.
// shadow (default): each match is a line in ~/.claude/logs/completion-check.jsonl,
// nothing is blocked. block: the stop is refused once (never while
// stop_hook_active, so the model is not looped).

async function logMatch(
  $: EngineInterface,
  row: Record<string, unknown>,
): Promise<void> {
  try {
    const file = `${await $.env.get("HOME")}/.claude/logs/completion-check.jsonl`;
    await $.process.run([
      "/bin/mkdir",
      "-p",
      file.slice(0, file.lastIndexOf("/")),
    ]);
    await $.process.run(["/usr/bin/tee", "-a", file], {
      stdin: `${JSON.stringify(row)}\n`,
    });
  } catch (err) {
    $.ui.log(`nwdesigns-mods completion-check: log failed: ${msg(err)}`);
  }
}

export function registerCompletionCheck(
  on: On,
  mode: "shadow" | "block",
): void {
  on("classic.Stop", async ($, e, next) => {
    const hit = firstMatch(e.last_assistant_message ?? "");
    if (!hit) return next(e);
    const blocked = mode === "block" && !e.stop_hook_active;
    await logMatch($, {
      ts: new Date(await $.clock.now()).toISOString(),
      session: e.session_id,
      cwd: e.cwd,
      mode,
      label: hit.label,
      match: hit.match,
      blocked,
    });
    return blocked ? { block: blockReason(hit.label) } : next(e);
  });
}
