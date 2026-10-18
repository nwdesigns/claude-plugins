import type { On } from "claude-code";
import { describe, expect, mock, test, type Engine } from "claude-code/testing";

// `claude plugin test plugins/nwdesigns-mods`: every noun the mods call on
// `$` is answered below from memory; nothing touches the disk or a process.

const HOME = "/home/t";
const CWD = "/srv/proj";
const PLUGIN = "nwdesigns-mods";

type World = {
  clock: ReturnType<typeof mock.clock>;
  files: Record<string, string>;
  writes: Array<[string, string]>;
  argv: string[][];
  core: string[]; // tool calls that reached the bottom
  logs: string[];
  mtime: Record<string, number>;
  toasts: string[];
  fills: Array<[string, string]>;
  answer: string; // the ui.ask label chosen
  asks: string[];
  surfaces: string[];
  bash?: (command: string) => Promise<boolean>; // false = the call failed
  renders: unknown[]; // props that reached the engine's drawing
  result?: unknown; // what the tool returns at the bottom; {} when unset
  deny?: string; // the bottom answers with this deny instead
  fail?: Record<string, "stat" | "read" | "write">; // path → the fs call that fails (EACCES)
  placed: boolean; // what ui.open answers
  git?: (argv: readonly string[]) => string; // what a git command prints
};

function world(on: On): World {
  const w: World = {
    clock: mock.clock(on, { now: Date.parse("2026-10-11T10:00:00Z") }),
    files: {},
    writes: [],
    argv: [],
    core: [],
    logs: [],
    mtime: {},
    toasts: [],
    fills: [],
    answer: "Cancel",
    asks: [],
    surfaces: ["terminal"],
    renders: [],
    placed: true,
  };
  on("ui.toast", async (_$, e) => {
    w.toasts.push(e.text);
    return { value: undefined };
  });
  on("prompt.fill", async (_$, e) => {
    w.fills.push([e.text, e.mode ?? "replace"]);
    return { isFilled: true };
  });
  on("ui.open", async () => ({ value: { isPlaced: w.placed } }) as never);
  on("ui.close", async () => ({ value: undefined }) as never);
  on("session.surfaces", async () => ({ value: w.surfaces as never }));
  on(
    "command.register",
    async (_$, e) => ({ value: { command: e.name } }) as never,
  );
  on("session.measure", async (_$, e) => ({ changed: e.changed }));
  // A path is a file when w.files has it, a dir when a file lies under it.
  on("fs.stat", async (_$, e) => {
    const isDir = Object.keys(w.files).some((p) => p.startsWith(`${e.path}/`));
    if (w.fail?.[e.path] === "stat") throw new Error(`EACCES ${e.path}`);
    if (!(e.path in w.files) && !isDir) throw new Error(`ENOENT ${e.path}`);
    return {
      value: {
        kind: isDir ? ("dir" as const) : ("file" as const),
        size: 1,
        mtimeMs: w.mtime[e.path] ?? 0,
        isLink: false,
        realPath: e.resolve ? e.path : undefined,
      },
    };
  });
  mock.env(on, { HOME });
  mock.store(on);
  on("session.cwd", async () => ({ value: CWD }));
  on("ui.log", async (_$, e) => {
    w.logs.push(e.text);
    return { value: undefined };
  });
  on("fs.read", async (_$, e) => {
    if (!(e.path in w.files)) throw new Error(`ENOENT ${e.path}`);
    if (w.fail?.[e.path] === "read") throw new Error(`EACCES ${e.path}`);
    return { value: w.files[e.path] };
  });
  on("fs.write", async (_$, e) => {
    if (w.fail?.[e.path] === "write") throw new Error(`EACCES ${e.path}`);
    w.writes.push([e.path, e.text]);
    w.files[e.path] = e.text;
    return { value: undefined };
  });
  on("process.run", async (_$, e) => {
    w.argv.push([...e.argv]);
    // The hold loop polls on `sleep`: it waits on the mocked clock.
    if (e.argv[0] === "sleep") await w.clock.sleep(Number(e.argv[1]) * 1000);
    // Blast Radius measures `rm` with a bash script: 2 files, 2 KB, 1 path.
    const stdout =
      e.argv[0] === "git"
        ? (w.git?.(e.argv) ?? "")
        : e.argv[0] === "bash" && String(e.argv[2]).includes("compgen")
          ? "2 2048 1\nbuild/a.js\nbuild/b.js\n"
          : "";
    return {
      value: {
        exitCode: 0,
        stdout,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("prompt.submit", async (_$, e) => ({ text: e.text, context: e.context }));
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  on("ui.render", async (_$, e) => {
    w.renders.push(e.props); // the engine's own drawing: an empty Box
    return h(_$.ui.resolve(e).Box, null) as never;
  });
  on("classic.Stop", async () => ({}));
  on("tool.call", async (_$, e) => {
    if (e.tool === "Bash" && w.bash && !(await w.bash(String(e.command))))
      return { result: {}, isError: true } as never;
    if (e.tool === "AskUserQuestion") {
      const { questions } = e as unknown as {
        questions: { question: string }[];
      };
      const q = questions[0]!.question;
      w.asks.push(q);
      return {
        result: { questions, answers: { [q]: w.answer } },
      } as never;
    }
    if (w.deny !== undefined) return { deny: w.deny };
    w.core.push(String(e.tool));
    if (e.tool === "Write") {
      const { file_path, content } = e as unknown as {
        file_path: string;
        content: string;
      };
      w.files[file_path] ??= content; // a real Write creates the file
      w.mtime[file_path] ??= w.clock.now();
    }
    return { result: w.result ?? {} };
  });
  return w;
}

const human = { kind: "composer" } as const;

function prompt($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: human });
}

function write(file_path: string) {
  return {
    tool: "Write" as const,
    tool_use_id: `tu-${file_path}`,
    file_path,
    content: "x",
  };
}

const bandProps = (bodyColumns = 120) =>
  ({
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns,
  }) as never;

function mountBand($: Engine) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: "terminal",
    component: "AbovePrompt",
    props: bandProps(),
  });
}

async function bandText($: Engine): Promise<string> {
  const ui = await mountBand($);
  return (await ui.find({ type: "Text" }))?.text ?? "";
}

// ---------------------------------------------------------------- status-band

describe("status-band", () => {
  function measure($: Engine, percent: number) {
    return $.session.measure({
      context: { percent, tokens: 190_000, window: 1_000_000 },
      rateLimits: [],
      changed: ["context"],
    });
  }

  const check = {
    tool: "Bash" as const,
    tool_use_id: "b1",
    command: "bun test",
  };

  test("no band at rest; an edit shows the verify button, which fills the box", async ($, on) => {
    const w = world(on);
    expect(await bandText($)).toBe("");
    await $.tool.call(write(`${CWD}/a.ts`));
    await $.tool.call(write(`${CWD}/b.ts`));
    expect(await bandText($)).toBe("2 edits since the last check");
    const ui = await mountBand($);
    await ui.press({ key: "verify" });
    expect(w.fills).toEqual([["run the project checks", "append"]]);
  });

  test("the band composes: the drawing beneath still runs", async ($, on) => {
    const w = world(on);
    await $.tool.call(write(`${CWD}/a.ts`));
    w.renders = [];
    expect(await bandText($)).toBe("1 edit since the last check");
    expect(w.renders).toHaveLength(1);
  });

  test("a passed check offers push; a human prompt clears it", async ($, on) => {
    const w = world(on);
    await $.tool.call(write(`${CWD}/a.ts`));
    await $.tool.call(check);
    expect(await bandText($)).toBe("checked, ready to push");
    const ui = await mountBand($);
    await ui.press({ key: "push" });
    expect(w.fills).toEqual([["commit and push", "append"]]);
    await prompt($, "next task");
    expect(await bandText($)).toBe("");
  });

  test("an edit during the check or a failed check leaves no checked item", async ($, on) => {
    const w = world(on);
    // The check runs 1 s; a parallel Write lands while it runs.
    w.bash = async (command) => {
      await w.clock.sleep(1000);
      return command !== "npm run lint";
    };
    const running = $.tool.call(check);
    await w.clock.settle();
    await $.tool.call(write(`${CWD}/c.ts`));
    await w.clock.advance(1000);
    await running;
    expect(await bandText($)).toBe("1 edit since the last check");
    const lint = $.tool.call({ ...check, command: "npm run lint" });
    await w.clock.advance(1000);
    await lint;
    expect(await bandText($)).toBe("1 edit since the last check");
  });

  test("a check in the background is not a pass", async ($, on) => {
    const w = world(on);
    await $.tool.call(write(`${CWD}/a.ts`));
    await $.tool.call({ ...check, run_in_background: true } as never);
    w.result = { backgroundTaskId: "bg1" }; // moved to the background mid-run
    await $.tool.call(check);
    expect(await bandText($)).toBe("1 edit since the last check");
  });

  test("a context at 52% shows the compact button, which runs /compact", async ($, on) => {
    world(on);
    const runs: string[] = [];
    on("command.run", async (_$, e) => {
      runs.push(e.command);
      return {};
    });
    await measure($, 52);
    expect(await bandText($)).toBe("context 52%, time to compact");
    const ui = await mountBand($);
    await ui.press({ key: "compact" });
    expect(runs).toEqual(["compact"]);
  });
});

// ------------------------------------------------------------ collision-guard

describe("collision-guard", () => {
  const FILE = `${CWD}/shared.ts`;

  test("a file changed 3 min ago by another writer: ask, Cancel denies", async ($, on) => {
    const w = world(on);
    w.files[FILE] = "x";
    w.mtime[FILE] = w.clock.now() - 3 * 60_000;
    const r = await $.tool.call(write(FILE));
    expect(w.asks).toEqual([
      "shared.ts changed 3 min ago, not by this session. Edit it anyway?",
    ]);
    expect(r.deny).toMatch(
      /^collision-guard: shared.ts changed 3 min ago by another writer \(another session or an editor\)/,
    );
    expect(w.core).toEqual([]);
  });

  test("this session's own write is not asked again", async ($, on) => {
    const w = world(on);
    w.files[FILE] = "x";
    w.mtime[FILE] = w.clock.now() - 3 * 60_000;
    w.answer = "Edit anyway";
    await $.tool.call(write(FILE));
    await $.tool.call(write(FILE));
    expect(w.asks).toHaveLength(1);
    expect(w.core).toEqual(["Write", "Write"]);
  });

  test("a file this session changed through Bash is its own", async ($, on) => {
    const w = world(on);
    w.files[FILE] = "x";
    w.bash = async () => {
      w.mtime[FILE] = w.clock.now(); // sed -i during the run
      return true;
    };
    await $.tool.call({
      tool: "Bash",
      tool_use_id: "tu-sed",
      command: `sed -i s/a/b/ ${FILE}`,
    } as never);
    await $.tool.call(write(FILE));
    expect([w.asks, w.core]).toEqual([[], ["Bash", "Write"]]);
  });

  test("no one to ask (-p): pass with a log line", async ($, on) => {
    const w = world(on);
    w.files[FILE] = "x";
    w.mtime[FILE] = w.clock.now() - 3 * 60_000;
    w.surfaces = [];
    await $.tool.call(write(FILE));
    expect([w.asks, w.core]).toEqual([[], ["Write"]]);
  });

  test("bypassPermissions: pass without a question; the next default prompt asks again", async ($, on) => {
    const w = world(on);
    on("classic.UserPromptSubmit", async () => ({}));
    w.files[FILE] = "x";
    w.mtime[FILE] = w.clock.now() - 3 * 60_000;
    await submit($, "bypassPermissions");
    await $.tool.call(write(FILE));
    expect([w.asks, w.core]).toEqual([[], ["Write"]]);
    w.mtime[FILE] = w.clock.now() - 2 * 60_000; // another writer again
    await submit($, "default");
    await $.tool.call(write(FILE));
    expect(w.asks).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ recording

describe("recording", () => {
  test("/rec masks an email in the drawing; the band shows REC and stop rec turns it off", async ($, on) => {
    const w = world(on);
    const run = (args: string) =>
      $.command.run({
        command: "rec",
        args,
        origin: { kind: "composer" },
        presentation: { isFullscreen: false, columns: 80 },
      });
    expect((await run("")).text).toMatch(/^REC on\./);
    await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "AssistantMessage",
      props: { text: "write to a.b@example.com", isFirstOfReply: true },
    });
    expect(w.renders).toEqual([
      { text: "write to [email]", isFirstOfReply: true },
    ]);
    expect(await bandText($)).toBe("● REC, screen redaction on");
    const ui = await mountBand($);
    await ui.press({ key: "rec" });
    expect(await bandText($)).toBe("");
  });
});

// ----------------------------------------------------------- completion-check

function stop(last_assistant_message: string, stop_hook_active = false) {
  return { last_assistant_message, stop_hook_active } as never;
}

describe("completion-check", () => {
  test("shadow (default): a match is logged, the stop is not blocked", async ($, on) => {
    const w = world(on);
    const r = await $.classic.Stop(
      stop("The flaky test is out of scope for this PR."),
    );
    expect(r.block).toBeUndefined();
    expect(w.argv.find((a) => a[0] === "/usr/bin/tee")).toEqual([
      "/usr/bin/tee",
      "-a",
      `${HOME}/.claude/logs/completion-check.jsonl`,
    ]);
  });

  test(
    "block mode refuses the stop once, never while stop_hook_active",
    { options: { completionCheck: "block" } },
    async ($, on) => {
      world(on);
      const first = await $.classic.Stop(
        stop("I skipped tests because they are slow."),
      );
      expect(first.block).toMatch(
        /^Rationalization detected: "Skipping test\/lint failures"/,
      );
      const again = await $.classic.Stop(
        stop("I skipped tests because they are slow.", true),
      );
      expect(again.block).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------- plan-effort

function effortWorld(on: On) {
  const w = world(on);
  const sent: Array<string | number | undefined> = [];
  on("classic.UserPromptSubmit", async () => ({}));
  on("command.run", async () => ({ text: "" }));
  on("turn.step", async function* (_$, e) {
    sent.push(e.effort);
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: [],
      stopReason: null,
      usage: null,
    };
  });
  return { w, sent };
}

async function step($: Engine, agentId?: string) {
  const s = $.turn.step({
    turnId: "t1",
    index: 0,
    model: "claude-opus-5-5",
    effort: "medium",
    messageCount: 1,
    agentId,
  });
  for await (const _ of s);
}

function submit($: Engine, permission_mode: string) {
  return $.classic.UserPromptSubmit({
    prompt: "plan the migration",
    permission_mode,
  } as never);
}

describe("plan-effort", () => {
  test("plan mode sends main-loop requests at xhigh; default mode leaves them", async ($, on) => {
    const { sent } = effortWorld(on);
    await submit($, "plan");
    await step($);
    await submit($, "default");
    await step($);
    expect(sent).toEqual(["xhigh", "medium"]);
  });

  test("no-op: a subagent's request in plan mode keeps its effort", async ($, on) => {
    const { sent } = effortWorld(on);
    await submit($, "plan");
    await step($, "agent-1");
    expect(sent).toEqual(["medium"]);
  });

  test("an explicit /effort turns the automatic xhigh off for the session", async ($, on) => {
    const { sent } = effortWorld(on);
    await $.command.run({
      command: "effort",
      args: "medium",
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 80 },
    });
    await submit($, "plan");
    await step($);
    expect(sent).toEqual(["medium"]);
  });

  test("ExitPlanMode inside a turn ends the raise", async ($, on) => {
    const { sent } = effortWorld(on);
    await submit($, "plan");
    await $.tool.call({ tool: "ExitPlanMode", tool_use_id: "x" } as never);
    await step($);
    expect(sent).toEqual(["medium"]);
  });
});

// --------------------------------------------------------------- blast-radius

describe("blast-radius", () => {
  const RM = ["rm", "-rf"].join(" ");
  const risky = {
    tool: "Bash" as const,
    tool_use_id: "b-rm",
    command: `${RM} build`,
  };
  const pane = ($: Engine) =>
    $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "Pane",
      requestId: "blast-radius",
      props: {
        title: "Blast Radius",
        isFocused: true,
        bodyColumns: 80,
      } as never,
    });

  test("a risky command is held with its file list; Cancel denies, the band drops its digits meanwhile", async ($, on) => {
    const w = world(on);
    await $.tool.call(write(`${CWD}/a.ts`)); // the band has a verify button
    const call = $.tool.call(risky);
    await w.clock.settle();
    const ui = await pane($);
    expect((await ui.find({ type: "Text" }))?.text).toContain("Blast Radius");
    const band = await mountBand($);
    expect(await band.find({ key: "verify" })).toBeUndefined();
    await ui.press({ key: "cancel" });
    await w.clock.advance(250);
    const r = await call;
    expect(r.deny).toMatch(
      /the user pressed Cancel\. It would have: delete 2 files/,
    );
    expect(w.core).toEqual(["Write"]);
  });

  test("Proceed runs the command", async ($, on) => {
    const w = world(on);
    const call = $.tool.call(risky);
    await w.clock.settle();
    await (await pane($)).press({ key: "proceed" });
    await w.clock.advance(250);
    expect((await call).deny).toBeUndefined();
    expect(w.core).toEqual(["Bash"]);
  });

  test("bypassPermissions runs a risky command at once; the next default prompt holds again", async ($, on) => {
    const w = world(on);
    on("classic.UserPromptSubmit", async () => ({}));
    await submit($, "bypassPermissions");
    expect((await $.tool.call(risky)).deny).toBeUndefined();
    expect(w.core).toEqual(["Bash"]);
    expect(w.toasts).toEqual([`Blast Radius: bypass mode, running ${RM}`]);
    await submit($, "default");
    const call = $.tool.call(risky);
    await w.clock.settle();
    await (await pane($)).press({ key: "cancel" });
    await w.clock.advance(250);
    expect((await call).deny).toMatch(/Cancel/);
  });

  test("no pane room: the report is drawn in the band, below the rows beneath", async ($, on) => {
    const w = world(on);
    w.placed = false;
    const call = $.tool.call(risky);
    await w.clock.settle();
    w.renders = [];
    const band = await mountBand($);
    expect(w.renders).toHaveLength(1);
    await band.press({ key: "cancel" });
    await w.clock.advance(250);
    expect((await call).deny).toMatch(/Cancel/);
  });

  test("no-op: a plain command runs at once", async ($, on) => {
    const w = world(on);
    await $.tool.call({ ...risky, command: "ls -la" });
    expect(w.core).toEqual(["Bash"]);
  });

  test("reset --hard to a target on a clean tree reports the branch move", async ($, on) => {
    const w = world(on);
    w.git = (argv) => (argv[1] === "rev-list" ? "2\n" : "");
    const call = $.tool.call({ ...risky, command: "git reset --hard HEAD~2" });
    await w.clock.settle();
    await (await pane($)).press({ key: "cancel" });
    await w.clock.advance(250);
    expect((await call).deny).toMatch(
      /It would have: move the branch to HEAD~2, off 2 commits\./,
    );
  });
});

// -------------------------------------------------------------- secret-redact

const WITHHELD = "[withheld: secret redaction failed]";

describe("secret-redact", () => {
  const CANARY = "CANARYsynthetic0123456789zz";
  const PROJ = "CANARYproject9876543210yy";
  const EXTRA_ENV = `${HOME}/.config/team/secrets.env`;
  const EXTRA_JSON = `${HOME}/.config/team/auth.json`;
  const bash = {
    tool: "Bash" as const,
    tool_use_id: "b-secret",
    command: "cat .env",
  };
  const out = (stdout: string) => ({ stdout, stderr: "", interrupted: false });

  test("the project .env values and a token format are redacted in the stored result", async ($, on) => {
    const w = world(on);
    w.files[`${CWD}/.env`] = `export DB_PASS="${PROJ}"\nDEBUG=true\n`;
    w.result = out(`p=${PROJ} gh=ghp_${"a".repeat(36)} debug=true`);
    const r = await $.tool.call(bash);
    expect(r.result).toEqual(
      out("p=[REDACTED:DB_PASS] gh=[REDACTED:github-token] debug=true"),
    );
  });

  test("no-op: a clean result comes back as core gave it", async ($, on) => {
    const w = world(on);
    w.result = out("a3f9c1d2e4b5a6978877665544332211aabbccdd");
    expect((await $.tool.call(bash)).result).toEqual(w.result);
  });

  test(
    "extraSecretFiles: env and JSON values are redacted",
    {
      options: {
        extraSecretFiles: `~/.config/team/secrets.env, ${EXTRA_JSON}`,
      },
    },
    async ($, on) => {
      const w = world(on);
      w.files[EXTRA_ENV] = `OPENAI_API_KEY=${CANARY}\n`;
      w.files[EXTRA_JSON] = JSON.stringify({ tokens: { access_token: PROJ } });
      w.result = out(`k=${CANARY} t=${PROJ}`);
      expect((await $.tool.call(bash)).result).toEqual(
        out("k=[REDACTED:OPENAI_API_KEY] t=[REDACTED:tokens.access_token]"),
      );
    },
  );

  test(
    "extraSecretFiles: an unreadable or malformed file with no cached values withholds the result",
    { options: { extraSecretFiles: EXTRA_JSON } },
    async ($, on) => {
      const w = world(on);
      w.files[EXTRA_JSON] = "{ not json";
      w.result = out(`t=${PROJ}`);
      expect(await $.tool.call(bash)).toEqual({ deny: WITHHELD });
      w.files[EXTRA_JSON] = JSON.stringify({ token: PROJ });
      w.fail = { [EXTRA_JSON]: "read" };
      expect(await $.tool.call(bash)).toEqual({ deny: WITHHELD });
      expect(w.logs.join("\n")).not.toContain(PROJ);
    },
  );

  test(
    "extraSecretFiles: a missing file withholds; a later stat failure keeps the cached values",
    { options: { extraSecretFiles: EXTRA_ENV } },
    async ($, on) => {
      const w = world(on);
      w.result = out(`k=${CANARY}`);
      expect(await $.tool.call(bash)).toEqual({ deny: WITHHELD });
      w.files[EXTRA_ENV] = `API_TOKEN=${CANARY}\n`;
      expect((await $.tool.call(bash)).result).toEqual(
        out("k=[REDACTED:API_TOKEN]"),
      );
      w.fail = { [EXTRA_ENV]: "stat" };
      expect((await $.tool.call(bash)).result).toEqual(
        out("k=[REDACTED:API_TOKEN]"),
      );
    },
  );

  test("an unreadable optional project .env does not withhold", async ($, on) => {
    const w = world(on);
    w.files[`${CWD}/.env`] = `DB_PASS=${PROJ}\n`;
    w.fail = { [`${CWD}/.env`]: "read" };
    w.result = out("ok");
    expect((await $.tool.call(bash)).result).toEqual(out("ok"));
  });

  test("a deny text is redacted too", async ($, on) => {
    const w = world(on);
    w.files[`${CWD}/.env`] = `DB_PASS=${PROJ}\n`;
    w.deny = `refused: ${PROJ} and ghp_${"a".repeat(36)}`;
    const r = await $.tool.call(bash);
    expect(r.deny).toBe(
      "refused: [REDACTED:DB_PASS] and [REDACTED:github-token]",
    );
  });

  test(
    "option off: nothing is redacted",
    { options: { secretRedact: false } },
    async ($, on) => {
      const w = world(on);
      w.result = { stdout: `gh=ghp_${"a".repeat(36)}` };
      expect((await $.tool.call(bash)).result).toEqual(w.result);
    },
  );

  test("a Bash result over the size limit is a deny, never the raw result", async ($, on) => {
    const w = world(on);
    w.result = out("x".repeat(8_000_001));
    expect(await $.tool.call(bash)).toEqual({ deny: WITHHELD });
  });

  test("a spill file that cannot be rewritten is deleted", async ($, on) => {
    const w = world(on);
    const spill = `${HOME}/.claude/projects/p/s/tool-results/x.txt`;
    w.files[spill] = `raw ghp_${"a".repeat(36)}`;
    w.fail = { [spill]: "write" };
    w.result = { ...out("preview"), persistedOutputPath: spill };
    const r = await $.tool.call(bash);
    expect(w.argv).toContainEqual(["/bin/unlink", spill]);
    expect(r.deny).toBeUndefined();
  });
});

// ----------------------------------------------------------------- secret-box

describe("secret-box", () => {
  const TOOL = "mcp__nwdesigns-mods__request_secret";
  // Not a credential name, and a value secret-redact alone would keep.
  const VALUE = "correct-horse-battery-staple";
  const DOT = "•";
  const ask = (name = "SHOP_PHRASE") =>
    ({ tool: TOOL, tool_use_id: "rs", name, reason: "the shop" }) as never;
  const box = ($: Engine) =>
    $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "Pane",
      requestId: "secret-box",
      props: { title: "secret-box", isFocused: true, bodyColumns: 80 } as never,
    });

  test("request_secret writes .env and .gitignore; the result never holds the value, a later result redacts it", async ($, on) => {
    const w = world(on);
    w.files[`${CWD}/.env`] = "A=1\n";
    const call = $.tool.call(ask());
    await w.clock.settle();
    const ui = await box($);
    await ui.input({ key: "secret", text: VALUE, kind: "change" });
    // The field is drawn again as dots: the typed text never stays on screen.
    expect((await ui.find({ key: "secret" }))?.props).toMatchObject({
      value: DOT.repeat(VALUE.length),
    });
    await ui.input({ key: "secret", text: DOT.repeat(VALUE.length) });
    await w.clock.advance(300);
    const r = await call;
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(String(r.result)).toContain("SHOP_PHRASE");
    expect(w.files[`${CWD}/.env`]).toBe(`A=1\nSHOP_PHRASE=${VALUE}\n`);
    expect(w.files[`${CWD}/.gitignore`]).toBe(".env\n");
    w.result = { stdout: `phrase=${VALUE}` };
    const later = await $.tool.call({
      tool: "Bash",
      tool_use_id: "b-cat",
      command: "cat .env",
    });
    expect(later.result).toEqual({ stdout: "phrase=[REDACTED:SHOP_PHRASE]" });
  });

  test("Enter on an empty box cancels: nothing is written", async ($, on) => {
    const w = world(on);
    const call = $.tool.call(ask());
    await w.clock.settle();
    await (await box($)).input({ key: "secret", text: "" });
    await w.clock.advance(300);
    expect(String((await call).result)).toContain("cancelled");
    expect(w.writes).toEqual([]);
  });

  test("git add .env and a commit with .env staged are denied; @.env is denied", async ($, on) => {
    const w = world(on);
    w.git = (argv) => (argv.includes("diff") ? ".env\nsrc/a.ts\n" : "");
    const bash = (command: string) =>
      $.tool.call({ tool: "Bash", tool_use_id: "g", command });
    expect((await bash("git add .env")).deny).toMatch(/staging a \.env/);
    expect((await bash("git commit -m x")).deny).toMatch(/include a \.env/);
    expect(w.core).toEqual([]);
    const m = await $.prompt.mention({ path: `${CWD}/.env` } as never);
    expect((m as { deny?: string }).deny).toMatch(/secret-box/);
  });

  test("a commit is checked in the repo it runs in: cd and git -C", async ($, on) => {
    const w = world(on);
    // Only the other repo has .env staged.
    w.git = (argv) => (argv[2] === `${CWD}/other` ? ".env\n" : "");
    const bash = (command: string) =>
      $.tool.call({ tool: "Bash", tool_use_id: "g", command });
    expect((await bash("cd other && git commit -m x")).deny).toMatch(/\.env/);
    expect((await bash("git -C other commit -m x")).deny).toMatch(/\.env/);
    expect((await bash("git commit -m x")).deny).toBeUndefined();
  });

  test("an absolute git and an unexpanded folder are still checked", async ($, on) => {
    const w = world(on);
    w.git = (argv) => (argv[2] === CWD ? ".env\n" : "");
    const bash = (command: string) =>
      $.tool.call({ tool: "Bash", tool_use_id: "g", command });
    expect((await bash("/usr/bin/git commit -m x")).deny).toMatch(/\.env/);
    expect((await bash('cd "$PWD" && git commit -m x')).deny).toMatch(/\.env/);
    expect((await bash('git -C "$PWD" commit -m x')).deny).toMatch(/\.env/);
  });

  test(
    "option off: no tool, no guard",
    { options: { secretBox: false } },
    async ($, on) => {
      const w = world(on);
      await $.tool.call({
        tool: "Bash",
        tool_use_id: "g",
        command: "git add .env",
      });
      expect(w.core).toEqual(["Bash"]);
    },
  );
});

// ------------------------------------------------------------- prompt-bouncer

describe("prompt-bouncer", () => {
  const BOUNCE =
    '{"pass": false, "reason": "PPC is not a project term.", "suggestion": "aggiorna il deck Google Ads"}';
  function bouncerWorld(on: On, reply: string | Error = BOUNCE) {
    const w = world(on);
    const asked: string[] = [];
    w.files[`${CWD}/GLOSSARY.md`] = "| Term | Not |\n| Google Ads | PPC |\n";
    on("session.messages", async () => ({ value: [] as never }));
    on("model.complete", async (_$, e) => {
      asked.push(e.prompt);
      if (reply instanceof Error) throw reply;
      return {
        value: { isAnswered: true, text: reply, usage: {} } as never,
      };
    });
    return { w, asked };
  }

  test("warn: the prompt enters at once, then a toast suggests the term", async ($, on) => {
    const { w, asked } = bouncerWorld(on);
    const r = await prompt($, "aggiorna il deck PPC");
    expect(r.drop).toBeUndefined();
    await w.clock.settle();
    expect(asked[0]).toContain("Google Ads | PPC");
    expect(w.toasts).toContain("Glossary: aggiorna il deck Google Ads");
  });

  test(
    "block: the prompt is dropped with the suggestion",
    { options: { promptBouncer: "block" } },
    async ($, on) => {
      bouncerWorld(on);
      const r = await prompt($, "aggiorna il deck PPC");
      expect(r.drop).toMatch(/Try: aggiorna il deck Google Ads.*\/force/);
    },
  );

  test(
    "block: a model throw lets the prompt in",
    { options: { promptBouncer: "block" } },
    async ($, on) => {
      bouncerWorld(on, new Error("down"));
      expect((await prompt($, "aggiorna il deck PPC")).drop).toBeUndefined();
    },
  );

  test("no GLOSSARY.md: no model call", async ($, on) => {
    const { w, asked } = bouncerWorld(on);
    delete w.files[`${CWD}/GLOSSARY.md`];
    await prompt($, "aggiorna il deck PPC");
    await w.clock.settle();
    expect(asked).toEqual([]);
  });
});

// --------------------------------------------------------------- diagram-pane

describe("diagram-pane", () => {
  const REPLY =
    "The flow:\n\n```mermaid\nflowchart TD\n  A[Cart] --> B[Pay]\n```\n";
  const MAP =
    '{"title":"checkout","nodes":[{"id":"a","label":"cart.ts","kind":"file"}],"edges":[]}';
  const turn = ($: Engine) =>
    $.turn.complete({
      answer: REPLY,
      durationMs: 1,
      isAborted: false,
      turnId: "t",
      reason: "completed",
    } as never);

  test(
    "a mermaid reply is pinned; the gate answers NO, so no second fork runs",
    { options: { diagramPane: true, diagramEveryTurns: 1 } },
    async ($, on) => {
      const w = world(on);
      let forks = 0;
      let gates = 0;
      on("session.messages", async () => ({
        value: [
          { role: "user", text: "draw it", toolUses: [] },
          { role: "assistant", text: REPLY, toolUses: [] },
        ] as never,
      }));
      on("session.id", async () => ({ value: "s1" as never }));
      on("ui.panes", async () => ({ value: [] as never }));
      on("turn.complete", async (_$, e) => ({ text: e.answer }));
      on("model.fork", async () => {
        forks++;
        return { value: { isAnswered: true, text: MAP, usage: {} } as never };
      });
      on("model.complete", async () => {
        gates++;
        return { value: { isAnswered: true, text: "NO", usage: {} } as never };
      });
      await turn($);
      await w.clock.settle();
      await turn($);
      await w.clock.settle();
      expect([forks, gates]).toEqual([1, 1]);
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface: "terminal",
        component: "Pane",
        requestId: "diagram-pane",
        props: {
          title: "Diagrams",
          isFocused: false,
          bodyColumns: 60,
        } as never,
      });
      const text = JSON.stringify(await ui.drawn());
      expect(text).toContain("1 pinned");
      expect(text).toContain("│ Cart │");
      expect(text).toContain("checkout");
    },
  );
});
