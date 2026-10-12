// Ported from ray-amjad/claude-code-mods b75f32f, plugins/secret-box/hooks/register.jsx
// (MIT, Copyright (c) 2026 Ray Amjad; see NOTICE). Changes: TypeScript; the
// upstream redactor and its placeholders dropped (secret-redact hides a saved
// value from the next tool result on); the .env helpers in lib/dotenv.ts; the
// band fallback composes with the rows beneath; the guard fails open.
//
// secret-box: Claude can ask for a secret without ever seeing it.
//
// tool.call (request_secret): open a masked box, wait for the person, write
// NAME=value to <cwd>/.env. The result names the variable and the file only.
// tool.call (Bash): refuse a `git add` of a .env file, and a commit whose
// staged list holds one. prompt.mention: refuse `@.env`, which would put every
// value in the prompt, where secret-redact never looks.

import type { EngineInterface, On } from "claude-code";

import { gitCommits } from "../lib/blast.ts";
import {
  ensureIgnored,
  isEnvFile,
  stagesEnv,
  upsertEnv,
} from "../lib/dotenv.ts";
import { handed } from "../lib/secrets.ts";
import { msg, resolvePath } from "../lib/util.ts";

const TOOL = "mcp__nwdesigns-mods__request_secret";
const PANE_ID = "secret-box";
const POLL_SECONDS = "0.3";
const LIMIT_MS = 10 * 60 * 1000;
const DOT = "•";

type Pending = {
  name: string;
  reason: string;
  value: string;
  answer: string | undefined; // set on Enter (the value) or Esc (empty)
  where: "pane" | "band";
};

// The one request being collected. The value lives only here until saved.
let pending: Pending | null = null;

// A file that is not there reads as empty. A read of one that is there is not
// caught, so an unreadable .env is never overwritten with one line.
async function readOrEmpty($: EngineInterface, path: string): Promise<string> {
  const st = await $.fs.stat(path).catch(() => undefined);
  return st?.kind === "file" ? String(await $.fs.read(path)) : "";
}

async function save(
  $: EngineInterface,
  cwd: string,
  name: string,
  value: string,
): Promise<string> {
  const env = `${cwd}/.env`;
  await $.fs.write(env, upsertEnv(await readOrEmpty($, env), name, value));
  const gi = `${cwd}/.gitignore`;
  const ignore = ensureIgnored(await readOrEmpty($, gi));
  if (ignore === null) return ".env";
  await $.fs.write(gi, ignore);
  return ".env (and added .env to .gitignore)";
}

// Why a Bash command is refused: it stages or commits a .env file. Each
// commit is checked in the repo it runs in: the folder a `cd` or `git -C`
// earlier on the line moved to (`cd -` is unknown: the session folder).
async function refusal($: EngineInterface, command: string): Promise<string> {
  if (stagesEnv(command)) return "staging a .env file is blocked.";
  const commits = gitCommits(command);
  if (commits.length === 0) return "";
  const cwd = await $.session.cwd();
  const home = (await $.env.get("HOME")) ?? "";
  for (const { dir, all } of commits) {
    // A folder the shell would expand ($PWD, `pwd`) is not known here: the
    // session folder is checked, as for a plain commit.
    const repo =
      dir === null || dir === "-" || /[$`]/.test(dir)
        ? cwd
        : resolvePath(dir === "~" ? "~/" : dir, home, cwd);
    const git = (...args: string[]) =>
      $.process.run(["git", "-C", repo, "diff", ...args], { cwd });
    const lists = [await git("--cached", "--name-only")];
    if (all) lists.push(await git("--name-only"));
    if (lists.some((r) => r.stdout.split("\n").some(isEnvFile)))
      return "this commit would include a .env file. Unstage it with git rm --cached.";
  }
  return "";
}

// null on a surface with no Input (mobile, vscode): the drawing beneath stays.
// `redraw` after each keystroke: the field shows what was typed until the
// hook draws it again, so the dots must be drawn at once.
function draw(
  t: ReturnType<EngineInterface["ui"]["resolve"]>,
  p: Pending,
  redraw: () => void,
) {
  if (!("Input" in t)) return null;
  const { Box, Text, Input } = t;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        Claude is asking for <Text color="yellow">{p.name}</Text>
      </Text>
      {p.reason ? <Text dimColor>{p.reason}</Text> : null}
      <Input
        key="secret"
        label="value "
        placeholder="paste it here, it stays masked"
        value={DOT.repeat(p.value.length)}
        submitLabel="save"
        autoFocus
        onInput={(text: string) => {
          // The leading dots are the part already held; the rest was just
          // typed or pasted. Backspace shortens the dots.
          let kept = 0;
          while (kept < text.length && text[kept] === DOT) kept++;
          p.value =
            p.value.slice(0, Math.min(kept, p.value.length)) + text.slice(kept);
          redraw();
        }}
        onSubmit={() => {
          p.answer = p.value;
        }}
      />
      <Text dimColor>
        {p.value.length ? `${p.value.length} characters · ` : ""}Enter saves ·{" "}
        {p.where === "band" ? "Enter on empty cancels" : "Esc cancels"} · Claude
        never sees the value
      </Text>
    </Box>
  );
}

export function registerSecretBox(on: On): void {
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    const started = await next(e);
    try {
      await $.tool.register({
        name: "request_secret",
        description:
          "Ask the user for a secret (API key, token, password) without it entering the conversation. " +
          "The user types it into a masked box and it is saved to the project .env. You get back the " +
          "variable name only, never the value. Use this INSTEAD of asking the user to paste a secret into chat.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Environment variable name, e.g. STRIPE_SECRET_KEY",
            },
            reason: {
              type: "string",
              description: "One short line telling the user why it is needed",
            },
          },
          required: ["name", "reason"],
        },
      });
    } catch (err) {
      $.ui.log(`nwdesigns-mods secret-box: ${msg(err)}`);
    }
    return started;
  });

  on("tool.call", { tool: TOOL }, async ($, e, next) => {
    const input = e as unknown as { name?: unknown; reason?: unknown };
    const name = String(input.name ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      return {
        result: `"${name}" is not a valid variable name. Use letters, digits and underscores.`,
      };
    if (pending)
      return {
        result: `secret-box is already waiting for ${pending.name}. Ask for one secret at a time.`,
      };
    const mine: Pending = {
      name,
      reason: String(input.reason ?? ""),
      value: "",
      answer: undefined,
      where: "pane",
    };
    pending = mine;
    let placed = false;
    try {
      placed = (
        await $.ui.open({
          id: PANE_ID,
          title: "secret-box",
          focus: true,
          closeOnEscape: true,
          rows: 7,
        })
      ).isPlaced;
      if (!placed) {
        mine.where = "band";
        $.ui.toast(
          `Claude wants ${name}: focus the box above the prompt and type it`,
          { timeoutMs: 10000 },
        );
      }
      $.ui.invalidate("ui.render");
      const deadline = (await $.clock.now()) + LIMIT_MS;
      while (
        mine.answer === undefined &&
        !next.signal.aborted &&
        (await $.clock.now()) < deadline
      )
        await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    } finally {
      pending = null;
      if (placed) await $.ui.close({ id: PANE_ID }).catch(() => undefined);
      $.ui.invalidate("ui.render");
    }
    const value = mine.answer;
    if (!value) return { result: `The user cancelled. ${name} was not saved.` };
    handed(name, value); // before the write: the next result is redacted
    const where = await save($, await $.session.cwd(), name, value);
    $.ui.toast(`${name} saved to ${where}`);
    return {
      result: `The user entered ${name}. It was saved to ${where}. You cannot see the value. Read it from the environment; in a shell use \`set -a; source .env; set +a\`.`,
    };
  }).catch(($, _e, next) => {
    pending = null;
    $.ui.log(`nwdesigns-mods secret-box: ${msg(next.error)}`);
    return { result: "secret-box failed. Nothing was saved." };
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    let why = "";
    try {
      why = await refusal($, String(e.command));
    } catch (err) {
      $.ui.log(`nwdesigns-mods secret-box: ${msg(err)}`);
    }
    return why
      ? { deny: `secret-box: ${why} A pushed key cannot be taken back.` }
      : next(e);
  });

  on("prompt.mention", { path: /(^|\/)\.env(\.[\w-]+)?$/ }, (_$, e, next) =>
    isEnvFile(e.path)
      ? {
          deny: "secret-box: @.env would put every value in the prompt. Ask Claude to read .env instead; secret redaction hides its values.",
        }
      : next(e),
  );

  // Esc (or any close) on the pane before Enter cancels.
  on("ui.close", (_$, e, next) => {
    if (e.id === PANE_ID && pending?.where === "pane") pending.answer = "";
    return next(e);
  });

  on(
    "ui.render",
    { component: "Pane", requestId: PANE_ID },
    ($, e, next) => (pending && draw($.ui.resolve(e), pending, () => $.ui.invalidate("ui.render"))) ?? next(e),
  );

  // The band composes: the rows beneath stay, the box is drawn above them.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const rest = await next(e);
    if (pending?.where !== "band") return rest;
    const box = draw($.ui.resolve(e), pending, () => $.ui.invalidate("ui.render"));
    if (!box) return rest;
    const { Box } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {box}
        {rest}
      </Box>
    );
  });
}
