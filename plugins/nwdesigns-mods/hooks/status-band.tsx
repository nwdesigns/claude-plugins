import { atom, read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";

import { CHECK_COMMAND, items, layout, PUSH_COMMAND } from "../lib/band.ts";
import type { ButtonKey } from "../lib/band.ts";
import { msg } from "../lib/util.ts";
import { isHolding } from "./blast-radius.tsx";

// status-band: an attention list above the prompt, empty at rest. Items: REC,
// a context at 50% or more, edits since the last check, a passed check. Every
// count is $.state, so each session keeps its own. The band composes: the
// rows of other mods beneath stay, this one is added below them.

const edits = atom({ plugin: "nwdesigns-mods", key: "edits" } as const, 0);
const gen = atom({ plugin: "nwdesigns-mods", key: "gen" } as const, 0);
const checked = atom(
  { plugin: "nwdesigns-mods", key: "checked" } as const,
  false,
);
const context = atom({ plugin: "nwdesigns-mods", key: "context" } as const, 0);
const rec = atom({ plugin: "nwdesigns-mods", key: "rec" } as const, false);
const denied = atom({ plugin: "nwdesigns-mods", key: "denied" } as const, 0);

const HUMAN = /^(composer|bridge)$/;

async function check<
  R extends { deny?: unknown; isError?: boolean; result?: unknown },
>($: EngineInterface, run: () => Promise<R>): Promise<R> {
  const before = await read($, gen);
  const r = await run();
  // A check moved to the background has not finished: no pass, no fail.
  if ((r.result as { backgroundTaskId?: unknown } | null)?.backgroundTaskId)
    return r;
  try {
    const ok = r.deny === undefined && !r.isError;
    // read() keeps the value this dispatch first saw; update() reads the
    // current one, so an edit that landed during the check is seen.
    let after = before;
    await update($, gen, (n) => (after = n ?? 0));
    if (ok && after === before) {
      await update($, edits, () => 0);
      await update($, checked, () => true);
    } else if (!ok) await update($, checked, () => false);
  } catch (err) {
    $.ui.log(`nwdesigns-mods status-band: ${msg(err)}`);
  }
  return r;
}

export function registerStatusBand(on: On): void {
  on("session.measure", async ($, e, next) => {
    try {
      const { percent } = e.context;
      if (e.changed.includes("context") && percent !== undefined)
        await update($, context, () => percent);
    } catch (err) {
      $.ui.log(`nwdesigns-mods status-band: measure: ${msg(err)}`);
    }
    return next(e);
  });

  // Counted after the call: a denied or failed edit does not count.
  on(
    "tool.call",
    { tool: ["Write", "Edit", "NotebookEdit"] },
    async ($, e, next) => {
      const r = await next(e);
      if (r.deny !== undefined || r.isError) return r;
      try {
        await update($, gen, (n) => (n ?? 0) + 1);
        await update($, edits, (n) => (n ?? 0) + 1);
        await update($, checked, () => false);
      } catch (err) {
        $.ui.log(`nwdesigns-mods status-band: ${msg(err)}`);
      }
      return r;
    },
  );

  // A check started in the background has no result yet. The `verify` skill
  // is not a check: its call returns the instructions, and the Bash checks it
  // runs count here.
  on("tool.call", { tool: "Bash", command: CHECK_COMMAND }, ($, e, next) =>
    e.run_in_background ? next(e) : check($, () => next(e)),
  );

  on(
    "tool.call",
    { tool: "Bash", command: PUSH_COMMAND },
    async ($, e, next) => {
      const r = await next(e);
      if (r.deny === undefined && !r.isError)
        await update($, checked, () => false).catch(() => undefined);
      return r;
    },
  );

  // A denied call in the main loop: a stuck unattended worker shows here.
  // Subagent calls do not count, their denials go back to the parent.
  on("tool.call", { tool: /./ }, async ($, e, next) => {
    const r = await next(e);
    if (r.deny !== undefined && e.agentId === undefined)
      await update($, denied, (n) => (n ?? 0) + 1).catch((err) =>
        $.ui.log(`nwdesigns-mods status-band: ${msg(err)}`),
      );
    return r;
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined)
      await update($, denied, () => 0).catch(() => undefined);
    return next(e);
  });

  // A person's new prompt starts new work: the checked item goes.
  on("prompt.submit", { origin: { kind: HUMAN } }, async ($, e, next) => {
    await update($, checked, () => false).catch((err) =>
      $.ui.log(`nwdesigns-mods status-band: ${msg(err)}`),
    );
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const rest = await next(e);
    if (e.props.hasSurvey) return rest;
    const list = items({
      rec: await read($, rec),
      percent: await read($, context),
      edits: await read($, edits),
      checked: await read($, checked),
      denied: await read($, denied),
    });
    const l = layout(list, e.props.bodyColumns, e.props.isWorking);
    if (!l) return rest;
    // While Blast Radius holds a call, its Proceed and Cancel own the digits.
    const buttons = isHolding() ? [] : l.buttons;
    const press: Record<ButtonKey, () => void> = {
      // fill, not submit: the person reads the box and presses Enter; append
      // keeps any draft already there
      verify: () =>
        void $.prompt.fill({ text: "run the project checks", mode: "append" }),
      push: () =>
        void $.prompt.fill({ text: "commit and push", mode: "append" }),
      compact: () => void $.command.run({ command: "compact" }),
      rec: () => void update($, rec, () => false),
    };
    const { Box, Button, Text } = $.ui.resolve(e);
    const color =
      l.tone === "bad" ? "red" : l.tone === "warn" ? "yellow" : undefined;
    return (
      <Box flexDirection="column">
        {rest}
        <Box
          flexDirection={l.wrap ? "column" : "row"}
          justifyContent="space-between"
          columnGap={2}
        >
          <Text color={color} dimColor={l.tone === "info"} wrap="truncate-end">
            {l.text}
          </Text>
          <Box flexShrink={0} gap={2}>
            {buttons.map((b) => (
              <Button
                key={b.key}
                label={b.label}
                hotkey={b.hotkey}
                plain
                onPress={press[b.key]}
              />
            ))}
          </Box>
        </Box>
      </Box>
    );
  });
}
