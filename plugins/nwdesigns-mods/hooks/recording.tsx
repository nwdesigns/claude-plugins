import { atom, read, update } from "claude-code";
import type { On } from "claude-code";

import { redact, redactDeep } from "../lib/redact.ts";
import { msg } from "../lib/util.ts";

// recording: /rec masks emails, keys, IBANs and amounts on screen in four
// transcript rows (assistant text, user text, tool calls, tool results). The
// stored messages, the tool results and the model input stay as they were.
// CAUTION: regex masks miss some values; not a security boundary. Toasts,
// status lines, the band, command output, dialogs and panes are not covered.

const rec = atom({ plugin: "nwdesigns-mods", key: "rec" } as const, false);

const COVERAGE =
  "Masks emails, keys, IBANs and amounts in transcript messages and tool rows only; not in toasts, status lines, command output, dialogs or panes.";

export function registerRecording(on: On): void {
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    const started = await next(e);
    try {
      await $.command.register({
        name: "rec",
        description: "Toggle screen redaction of emails, keys and amounts.",
        argumentHint: "[on|off]",
      });
    } catch (err) {
      $.ui.log(`nwdesigns-mods recording: ${msg(err)}`);
    }
    return started;
  });

  on("command.run", { command: "rec" }, async ($, e) => {
    const arg = e.args.trim();
    const was = await read($, rec);
    const now = arg === "on" ? true : arg === "off" ? false : !was;
    await update($, rec, () => now);
    $.ui.invalidate("ui.render");
    return {
      text: now
        ? `REC on. ${COVERAGE}`
        : "REC off: the screen shows everything again.",
    };
  });

  // Only new props for the drawing: e is frozen, nothing stored changes.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) =>
    (await read($, rec))
      ? next({ ...e, props: { ...e.props, text: redact(e.props.text) } })
      : next(e),
  );
  on("ui.render", { component: "UserMessage" }, async ($, e, next) =>
    (await read($, rec))
      ? next({ ...e, props: { ...e.props, text: redact(e.props.text) } })
      : next(e),
  );
  on("ui.render", { component: "ToolUse" }, async ($, e, next) =>
    (await read($, rec))
      ? next({
          ...e,
          props: {
            ...e.props,
            input: redactDeep(e.props.input),
            output: redactDeep(e.props.output),
          },
        })
      : next(e),
  );
  on("ui.render", { component: "ToolResult" }, async ($, e, next) =>
    (await read($, rec))
      ? next({
          ...e,
          props: { ...e.props, output: redactDeep(e.props.output) },
        })
      : next(e),
  );
}
