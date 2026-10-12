// Ported from ray-amjad/claude-code-mods b75f32f, plugins/prompt-bouncer/hooks/register.js
// (MIT, Copyright (c) 2026 Ray Amjad; see NOTICE). Changes: TypeScript; the
// project mode only (quick mode's rules are English only); a warn mode that
// never holds the prompt; only in a repo with a GLOSSARY.md; the last answer
// goes to the check, so a short reply is clear; /bouncer and globs dropped.
//
// prompt-bouncer: a Haiku check of each typed prompt against the repo's
// GLOSSARY.md (and the other bouncerDocs). warn: the prompt goes in at once,
// a toast suggests the project's term. block: the prompt is dropped with the
// suggestion; `/force <prompt>` sends it anyway. Fails open.

import type { EngineInterface, On } from "claude-code";

import {
  buildPrompt,
  parseVerdict,
  shouldCheck,
  SYSTEM,
  type Verdict,
} from "../lib/bouncer.ts";
import { msg } from "../lib/util.ts";

export type BouncerOptions = {
  mode: "warn" | "block";
  docs: string[];
  maxChars: number;
};

const HUMAN = /^(composer|bridge)$/;
const BLOCK_TIMEOUT_MS = 8000;
const WARN_TIMEOUT_MS = 20000;

// The text /force sent: let it through once.
let forceNext: string | null = null;

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.stat(path).then(
    (st) => st.kind === "file",
    () => false,
  );
}

async function loadDocs(
  $: EngineInterface,
  cwd: string,
  o: BouncerOptions,
): Promise<string> {
  let text = "";
  for (const f of o.docs) {
    if (text.length >= o.maxChars) break;
    const body = await $.fs.read(`${cwd}/${f}`).then(String, () => "");
    if (body)
      text += `\n--- ${f} ---\n${body.slice(0, o.maxChars - text.length)}`;
  }
  return text;
}

async function judge(
  $: EngineInterface,
  cwd: string,
  prompt: string,
  o: BouncerOptions,
  timeoutMs: number,
): Promise<Verdict> {
  const last =
    (await $.session.messages()).filter((m) => m.role === "assistant").at(-1)
      ?.text ?? "";
  const r = await $.model.complete({
    model: "haiku",
    maxTokens: 300,
    timeoutMs,
    system: SYSTEM,
    prompt: buildPrompt(await loadDocs($, cwd, o), last.slice(-4000), prompt),
  });
  return r.isAnswered ? parseVerdict(r.text) : { pass: true };
}

export function registerPromptBouncer(on: On, o: BouncerOptions): void {
  if (o.mode === "block") {
    on("session.start", { isInteractive: true }, async ($, e, next) => {
      const started = await next(e);
      try {
        await $.command.register({
          name: "force",
          description: "Send a prompt past prompt-bouncer",
          argumentHint: "<prompt>",
        });
      } catch (err) {
        $.ui.log(`nwdesigns-mods prompt-bouncer: ${msg(err)}`);
      }
      return started;
    });

    // A command cannot submit a prompt itself (it would wait on its own
    // turn), so a timer submits it once the command finished.
    on("command.run", { command: "force" }, async ($, e) => {
      const text = e.args.trim();
      if (!text) return { text: "Usage: /force <prompt>" };
      forceNext = text;
      $.clock.after(50, () =>
        $.prompt
          .submit({ text, asUser: true })
          .catch((err: unknown) =>
            $.ui.log(`nwdesigns-mods prompt-bouncer: /force: ${msg(err)}`),
          ),
      );
      return {};
    });
  }

  on("prompt.submit", { origin: { kind: HUMAN } }, async ($, e, next) => {
    const text = e.text.trim();
    if (forceNext !== null && text === forceNext) {
      forceNext = null;
      return next(e);
    }
    const cwd = await $.session.cwd();
    if (!shouldCheck(text, await exists($, `${cwd}/GLOSSARY.md`)))
      return next(e);

    if (o.mode === "warn") {
      const entered = await next(e);
      // Not awaited: the prompt never waits on the check.
      void judge($, cwd, text, o, WARN_TIMEOUT_MS).then(
        (v) => {
          if (!v.pass)
            $.ui.toast(`Glossary: ${v.suggestion ?? v.reason}`, {
              timeoutMs: 8000,
            });
        },
        (err: unknown) =>
          $.ui.log(`nwdesigns-mods prompt-bouncer: ${msg(err)}`),
      );
      return entered;
    }

    const v = await judge($, cwd, text, o, BLOCK_TIMEOUT_MS);
    if (v.pass) return next(e);
    // One line: a drop reason with newlines in it is mangled.
    return {
      drop: `prompt-bouncer: ${v.reason}${v.suggestion ? ` Try: ${v.suggestion}` : ""} (send anyway: /force <prompt>)`,
    };
  }).catch(($, e, next) => {
    $.ui.log(`nwdesigns-mods prompt-bouncer: ${msg(next.error)}`);
    return next.called ? undefined : next(e);
  });
}
