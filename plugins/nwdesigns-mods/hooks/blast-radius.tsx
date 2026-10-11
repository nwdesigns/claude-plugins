// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by nwdesigns, 2026-10-11: from blast-radius.mjs of
// anthropics/claude-code-playground (see NOTICE). Changes: TypeScript and
// JSX; the classifier moved to lib/blast.ts; WP-CLI and `rsync --delete`
// measured; the band fallback is a compact two-row form drawn above the
// other band rows, which it keeps; isHolding() for the status band.
//
// Blast Radius: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash): if the command is risky, work out its blast radius, open a
// pane with Proceed and Cancel, and hold the call until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

import type { EngineInterface, On } from "claude-code";

import { classify, isRemotePath, type Risk } from "../lib/blast.ts";

const PANE_ID = "blast-radius";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;

type Report = {
  summary: string;
  lines: string[];
  more?: number;
  note?: string;
};
type Decision = "proceed" | "cancel" | "timeout" | "interrupted" | "error";
type Held = {
  command: string;
  risk: Risk;
  report: Report | null;
  decision: Decision | null;
  where: "pane" | "band";
};

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held: Held | null = null;

/** True while a call waits on Proceed or Cancel: the status band drops its digits. */
export const isHolding = (): boolean => held !== null;

export function registerBlastRadius(on: On): void {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const risk = classify(String(e.command ?? ""));
    if (risk === null) {
      return next(e);
    }
    // One hold at a time. If another risky call is already held (a subagent's,
    // say), wait until it is answered. `held` is claimed with no await between
    // the check and the claim, so two waiting calls can't both get through.
    while (held !== null) {
      if (next.signal.aborted) {
        return {
          deny: "Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to.",
        };
      }
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine: Held = {
      command: String(e.command),
      risk,
      report: null,
      decision: null,
      where: "pane",
    };
    held = mine;

    let opened = { isPlaced: false };
    let summary = risk.label;
    try {
      // Measure where the command will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const sessionCwd = await $.session.cwd();
      const cwd = risk.dir
        ? await resolveDir($, sessionCwd, risk.dir)
        : sessionCwd;
      mine.report =
        cwd === null
          ? {
              summary: `${risk.label} in ${risk.dir}`,
              lines: [],
              note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.`,
            }
          : await measure($, risk, cwd);
      summary = mine.report.summary;

      opened = await $.ui.open({
        id: PANE_ID,
        title: "Blast Radius",
        focus: true,
        rows: paneRows(mine.report),
      });
      if (!opened.isPlaced) {
        mine.where = "band";
      }
      $.ui.invalidate("ui.render");

      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = "interrupted";
          break;
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = "timeout";
          break;
        }
        await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
      }
    } catch {
      mine.decision = "error"; // anything unexpected refuses the command
    } finally {
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed.
      try {
        if (opened.isPlaced) {
          await $.ui.close({ id: PANE_ID });
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
      $.ui.invalidate("ui.render");
    }

    const decision = mine.decision as Decision | null;
    if (decision === "proceed") {
      $.ui.toast("Blast Radius: running it");
      return next(e);
    }
    const why =
      decision === null
        ? "no answer was recorded"
        : {
            cancel: "the user pressed Cancel",
            timeout: "no answer within 10 minutes",
            interrupted: "the turn was interrupted",
            error: "Blast Radius hit an error while holding it",
          }[decision];
    return {
      deny: `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
    };
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, ($, e, next) => {
    if (held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held, held.report);
  });

  // The band composes: the rows beneath stay, the report is added below them.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const rest = await next(e);
    if (held === null || held.report === null || held.where !== "band") {
      return rest;
    }
    const { Box } = $.ui.resolve(e);
    // First and compact: the band can be a few rows high, and a button cut
    // off below it cannot be pressed.
    return (
      <Box flexDirection="column">
        {drawCompact($.ui.resolve(e), held, held.report)}
        {rest}
      </Box>
    );
  });
}

/** The band form: the summary and the buttons in two rows, no border, no list. */
function drawCompact(
  t: ReturnType<EngineInterface["ui"]["resolve"]>,
  state: Held,
  report: Report,
) {
  const { Box, Text, Button } = t;
  const decide = (choice: Decision) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text
          bold
          color="yellow"
        >{`⚠ Blast Radius · ${state.command} · `}</Text>
        <Text color="red" bold>
          {report.summary}
        </Text>
      </Text>
      <Box gap={2}>
        <Button
          key="proceed"
          label="Proceed"
          hotkey="1"
          plain
          onPress={decide("proceed")}
        />
        <Button
          key="cancel"
          label="Cancel"
          hotkey="2"
          plain
          autoFocus
          onPress={decide("cancel")}
        />
        <Text dimColor>widen the terminal for the file list</Text>
      </Box>
    </Box>
  );
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`;

async function resolveDir(
  $: EngineInterface,
  sessionCwd: string,
  dir: string,
): Promise<string | null> {
  if (dir === "-") {
    return null; // `cd -` depends on the shell's history
  }
  const run = await $.process.run(
    ["bash", "-c", CD_SCRIPT, "blast-radius", dir],
    { cwd: sessionCwd, timeoutMs: 5000 },
  );
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

// ---- Measuring the blast radius -------------------------------------------

/** { summary, lines, note } for the pane. Never throws: a failed read is said, not hidden. */
async function measure(
  $: EngineInterface,
  risk: Risk,
  cwd: string,
): Promise<Report> {
  try {
    switch (risk.kind) {
      case "rm":
        return await measureRm($, risk.targets, cwd);
      case "migrate":
        return await measureMigrations($, risk.tool, risk.label, cwd);
      case "wp-db":
        return {
          summary: `${risk.label}: replace or delete the whole WordPress database`,
          lines: [],
          note: "Not measured. Run wp db export first if you need a backup.",
        };
      case "wp-search-replace":
        return await measureSearchReplace($, risk.args, cwd);
      case "rsync-delete":
        return await measureRsync($, risk.args, cwd);
      default:
        return await measureGit($, risk, cwd);
    }
  } catch (error) {
    return {
      summary: `${risk.label} (could not measure it)`,
      lines: [],
      note: `Could not measure: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
    };
  }
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureRm(
  $: EngineInterface,
  targets: string[],
  cwd: string,
): Promise<Report> {
  if (targets.length === 0) {
    return {
      summary: "rm with no paths",
      lines: [],
      note: "No paths to expand.",
    };
  }
  const run = await $.process.run(
    ["bash", "-c", RM_SCRIPT, "blast-radius", ...targets],
    { cwd, timeoutMs: 15000 },
  );
  const [head, ...rest] = run.stdout.split("\n").filter((l) => l !== "");
  const [files, bytes, found] = (head ?? "0 0 0").split(" ").map(Number) as [
    number,
    number,
    number,
  ];
  if (!found) {
    return {
      summary: `delete nothing: no file matches ${targets.join(" ")}`,
      lines: [],
      note: "The paths don't exist, so rm has nothing to remove.",
    };
  }
  if (!files) {
    return {
      summary: `delete ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}`,
      lines: [],
      note: `Paths: ${targets.join(" ")}`,
    };
  }
  return {
    summary: `delete ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})`,
    lines: rest.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${targets.join(" ")}`,
  };
}

type GitRisk = Extract<
  Risk,
  { kind: "git-reset" | "git-clean" | "git-push-force" | "git-checkout" }
>;

async function measureGit(
  $: EngineInterface,
  risk: GitRisk,
  cwd: string,
): Promise<Report> {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk.args, cwd);
  }
  if (risk.kind === "git-clean") {
    const flags: string[] = [];
    const paths: string[] = [];
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i]!;
      if (a === "--") {
        paths.push(...risk.args.slice(i + 1));
        break;
      }
      if (a === "-e" || a === "--exclude") {
        flags.push(a, risk.args[i + 1] ?? "");
        i += 1;
      } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
        flags.push(a);
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
        if (kept !== "-") {
          flags.push(kept);
        }
      } else if (!a.startsWith("-")) {
        paths.push(a);
      }
    }
    const run = await $.process.run(
      ["git", "clean", "-n", ...flags, "--", ...paths],
      { cwd, timeoutMs: 15000 },
    );
    if (run.exitCode !== 0) {
      return {
        summary: "git clean (could not dry-run it)",
        lines: [],
        note: run.stderr.trim().slice(0, 200),
      };
    }
    const gone = run.stdout
      .split("\n")
      .filter((l) => l.startsWith("Would remove "))
      .map((l) => l.slice(13));
    return {
      summary:
        gone.length === 0
          ? "remove nothing: no untracked files match"
          : `remove ${gone.length} untracked ${gone.length === 1 ? "path" : "paths"}`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    };
  }
  const status = await $.process.run(["git", "status", "--porcelain"], {
    cwd,
    timeoutMs: 15000,
  });
  if (status.exitCode !== 0) {
    return {
      summary: `${risk.label} (not a git repo here?)`,
      lines: [],
      note: status.stderr.trim().slice(0, 200),
    };
  }
  const rows = status.stdout
    .split("\n")
    .filter((l) => l.length > 3 && !l.startsWith("??"));
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost =
    risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(
    ["git", "diff", "--shortstat", risk.kind === "git-reset" ? "HEAD" : "--"],
    { cwd, timeoutMs: 15000 },
  );
  return {
    summary:
      lost.length === 0
        ? "discard nothing: no uncommitted changes"
        : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note:
      stat.stdout.trim() !== ""
        ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.`
        : "From git status --porcelain.",
  };
}

async function measurePush(
  $: EngineInterface,
  args: string[],
  cwd: string,
): Promise<Report> {
  const positional = args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch || branch === "HEAD") {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeoutMs: 10000 },
    );
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  const ref = `${remote}/${branch}`;
  const known = await $.process.run(
    ["git", "rev-parse", "--verify", "--quiet", ref],
    { cwd, timeoutMs: 10000 },
  );
  if (known.exitCode !== 0) {
    return {
      summary: `force-push to ${ref}`,
      lines: [],
      note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.`,
    };
  }
  const log = await $.process.run(
    ["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`],
    { cwd, timeoutMs: 15000 },
  );
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  return {
    summary:
      dropped.length === 0
        ? `force-push to ${ref}: drops no commits`
        : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  };
}

// The same search-replace as a dry run, one row per changed table.
async function measureSearchReplace(
  $: EngineInterface,
  args: string[],
  cwd: string,
): Promise<Report> {
  const run = await $.process.run(
    ["wp", ...args, "--dry-run", "--report-changed-only", "--format=table"],
    { cwd, timeoutMs: 30000 },
  );
  if (run.exitCode !== 0) {
    return {
      summary: "wp search-replace (could not dry-run it)",
      lines: [],
      note: run.stderr.trim().slice(0, 200),
    };
  }
  const rows = run.stdout
    .split("\n")
    .filter((l) => /^\|\s*\w/.test(l) && !/^\|\s*Table\s*\|/.test(l));
  const total = /(\d+) replacements? to be made/.exec(run.stdout)?.[1];
  return {
    summary: total
      ? `replace ${total} values in the database`
      : "wp search-replace",
    lines: rows.slice(0, LIST_MAX).map((l) => l.replace(/\s+/g, " ").trim()),
    more: Math.max(0, rows.length - LIST_MAX),
    note: "From wp search-replace --dry-run. A database rewrite can't be undone without a backup (wp db export).",
  };
}

// The same rsync as a dry run, the deletions listed; a remote end is not
// measured (it can ask for a password).
async function measureRsync(
  $: EngineInterface,
  args: string[],
  cwd: string,
): Promise<Report> {
  if (args.some((a) => !a.startsWith("-") && isRemotePath(a))) {
    return {
      summary: "rsync --delete to or from another host",
      lines: [],
      note: "Not measured: one end is remote. Files on the target that the source lacks will be deleted.",
    };
  }
  const run = await $.process.run(
    ["rsync", "--dry-run", "--itemize-changes", ...args],
    { cwd, timeoutMs: 15000 },
  );
  if (run.exitCode !== 0) {
    return {
      summary: "rsync --delete (could not dry-run it)",
      lines: [],
      note: run.stderr.trim().slice(0, 200),
    };
  }
  const gone = run.stdout
    .split("\n")
    .filter((l) => l.startsWith("*deleting"))
    .map((l) => l.replace(/^\*deleting\s+/, ""));
  return {
    summary:
      gone.length === 0
        ? "delete nothing on the target"
        : `delete ${gone.length} ${gone.length === 1 ? "path" : "paths"} on the target`,
    lines: gone.slice(0, LIST_MAX),
    more: Math.max(0, gone.length - LIST_MAX),
    note: "From rsync --dry-run.",
  };
}

type Lister = {
  argv: string[];
  pending: (l: string) => boolean;
  strip: (l: string) => string;
};
const MIGRATION_LISTERS: Record<string, Lister> = {
  django: {
    argv: ["python3", "manage.py", "showmigrations", "--plan"],
    pending: (l) => l.startsWith("[ ]"),
    strip: (l) => l.slice(4),
  },
  alembic: {
    argv: ["alembic", "history", "-r", "current:head"],
    pending: (l) => l.includes("->"),
    strip: (l) => l,
  },
  rails: {
    argv: ["bin/rails", "db:migrate:status"],
    pending: (l) => /^\s*down\b/.test(l),
    strip: (l) => l.trim(),
  },
  prisma: {
    argv: ["npx", "--no-install", "prisma", "migrate", "status"],
    pending: (l) => /^\s{2}\S/.test(l),
    strip: (l) => l.trim(),
  },
};

async function measureMigrations(
  $: EngineInterface,
  tool: string,
  label: string,
  cwd: string,
): Promise<Report> {
  const lister = MIGRATION_LISTERS[tool];
  if (lister === undefined) {
    return {
      summary: "run migrations",
      lines: [],
      note: "I can't list the pending migrations for this tool, so the list is not shown.",
    };
  }
  let run: { exitCode: number; stdout: string };
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch {
    run = { exitCode: -1, stdout: "" };
  }
  if (run.exitCode !== 0) {
    return {
      summary: `run ${label}`,
      lines: [],
      note: `Couldn't list pending migrations (${lister.argv.join(" ")} failed).`,
    };
  }
  const pending = run.stdout
    .split("\n")
    .filter(lister.pending)
    .map(lister.strip);
  return {
    summary:
      pending.length === 0
        ? `run ${label}: nothing pending`
        : `apply ${pending.length} pending ${pending.length === 1 ? "migration" : "migrations"}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(" ")}.`,
  };
}

function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report: Report): number {
  return Math.min(24, 9 + report.lines.length + (report.more ? 1 : 0));
}

function draw(
  t: ReturnType<EngineInterface["ui"]["resolve"]>,
  state: Held,
  report: Report,
) {
  const { Box, Text, Button } = t;
  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice: Decision) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text bold color="yellow">{`⚠ Blast Radius · ${state.risk.label}`}</Text>
      <Text wrap="truncate-end">
        <Text dimColor>{"Command  "}</Text>
        <Text bold>{state.command}</Text>
      </Text>
      <Text>
        <Text dimColor>{"Would    "}</Text>
        <Text color="red" bold>
          {report.summary}
        </Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {report.lines.map((line, i) => (
          <Text key={`l${i}`} wrap="truncate-end">{`  ${line}`}</Text>
        ))}
        {report.more ? <Text dimColor>{`  + ${report.more} more`}</Text> : null}
      </Box>
      {report.note ? (
        <Text dimColor italic wrap="wrap">
          {report.note}
        </Text>
      ) : null}
      <Box marginTop={1} gap={2}>
        <Button
          key="proceed"
          label="Proceed"
          hotkey="1"
          plain
          onPress={decide("proceed")}
        />
        <Button
          key="cancel"
          label="Cancel"
          hotkey="2"
          plain
          autoFocus
          onPress={decide("cancel")}
        />
        <Text dimColor>Claude is waiting on your answer</Text>
      </Box>
    </Box>
  );
}
