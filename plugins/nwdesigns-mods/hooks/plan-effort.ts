import { atom, read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";

import { raise } from "../lib/effort.ts";
import type { EffortState } from "../lib/effort.ts";
import { msg } from "../lib/util.ts";

// plan-effort: in plan mode each model request of the main loop goes out at
// xhigh, unless the user ran /effort in this session.

const state = atom({ plugin: "nwdesigns-mods", key: "effort" } as const, null);

async function setState(
  $: EngineInterface,
  fn: (s: EffortState) => EffortState,
): Promise<void> {
  try {
    await update($, state, (s) => fn(s ?? { mode: "default", userSet: false }));
  } catch (err) {
    $.ui.log(`nwdesigns-mods plan-effort: ${msg(err)}`);
  }
}

export function registerPlanEffort(on: On): void {
  on("classic.UserPromptSubmit", async ($, e, next) => {
    const mode = e.permission_mode ?? "default";
    await setState($, (s) => ({ ...s, mode }));
    return next(e);
  });

  on("command.run", { command: "effort" }, async ($, e, next) => {
    await setState($, (s) => ({ ...s, userSet: true }));
    $.ui.log(
      "nwdesigns-mods plan-effort: /effort typed, plan-mode xhigh is off for this session",
    );
    return next(e);
  });

  // The mode changes inside a turn when ExitPlanMode runs.
  on(
    "tool.call",
    { tool: ["EnterPlanMode", "ExitPlanMode"] },
    async ($, e, next) => {
      const r = await next(e);
      if (r.deny === undefined && !r.isError && !e.agentId)
        await setState($, (s) => ({
          ...s,
          mode: e.tool === "EnterPlanMode" ? "plan" : "default",
        }));
      return r;
    },
  );

  on("turn.step", async function* ($, e, next) {
    let s: EffortState | null = null;
    try {
      s = await read($, state);
    } catch (err) {
      $.ui.log(`nwdesigns-mods plan-effort: ${msg(err)}`);
    }
    if (!raise(s, e.agentId, e.effort)) return yield* next(e);
    return yield* next({ ...e, effort: "xhigh" });
  });
}
