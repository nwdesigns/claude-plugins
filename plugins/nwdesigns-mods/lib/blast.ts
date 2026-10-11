// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by nwdesigns, 2026-10-11: from blast-radius.mjs of
// anthropics/claude-code-playground (see NOTICE). Changes: the classifier
// moved to this pure module and typed; new holds for WP-CLI (`wp db
// reset|drop|import`, `wp search-replace` on a remote or non-local target or
// on all tables) and `rsync --delete`.
//
// blast-radius: what counts as risky. No runtime imports.

export type Risk =
  | { kind: "rm"; label: string; targets: string[]; dir: string | null }
  | {
      kind: "git-reset" | "git-clean" | "git-push-force" | "git-checkout";
      label: string;
      args: string[];
      dir: string | null;
    }
  | { kind: "migrate"; tool: string; label: string; dir: string | null }
  | { kind: "wp-db"; label: string; args: string[]; dir: string | null }
  | {
      kind: "wp-search-replace";
      label: string;
      args: string[];
      dir: string | null;
    }
  | { kind: "rsync-delete"; label: string; args: string[]; dir: string | null };

type Cd = { cd: string | null };

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set([
  "-u",
  "-g",
  "-C",
  "-D",
  "-h",
  "-p",
  "-r",
  "-t",
  "-T",
  "-U",
]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set([
  "ls",
  "cat",
  "echo",
  "printf",
  "grep",
  "rg",
  "find",
  "less",
  "head",
  "tail",
  "cd",
  "git",
]);

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir: string | null, arg: string | undefined): string {
  if (
    arg === undefined ||
    arg === "~" ||
    arg.startsWith("/") ||
    arg.startsWith("~/")
  ) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** The first risky segment of a shell command, or null. */
export function classify(command: string): Risk | null {
  let dir: string | null = null; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes: Array<string | null> = []; // dir to restore when a ( subshell ) closes
  const pushed: Array<string | null> = []; // pushd stack, for popd
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = raw.match(/^\s*\(+/)?.[0].trim().length ?? 0;
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = tail.match(/\)+\s*$/)?.[0].trim().length ?? 0;
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }
    const risk = classifySegment(raw, dir, pushed);
    if (risk !== null && !("cd" in risk)) {
      return risk;
    }
    if (risk !== null) {
      dir = risk.cd; // a cd, pushd or popd moved the folder
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop()!; // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null;
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set([
  "command",
  "exec",
  "env",
  "nohup",
  "time",
  "then",
  "do",
  "else",
  "!",
]);

// A host a search-replace may target without a hold: a local dev site.
const LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|[\w.-]+\.(test|local|localhost|ddev\.site))(:\d+)?$/i;

/** The host of a URL-like value (`https://x.com/a`, `//x.com`, `x.com`), or null for plain text. */
function hostOf(value: string): string | null {
  const m =
    /^(?:[a-z][a-z\d+.-]*:)?\/\/([^/\s?#]+)/i.exec(value) ??
    /^([\w-]+(?:\.[\w-]+)+(?::\d+)?)(?:\/|$)/.exec(value);
  return m ? m[1]!.replace(/^[^@]*@/, "") : null;
}

/** True when `wp search-replace` (its args after the subcommand) must be held. */
export function riskySearchReplace(args: string[], remote: boolean): boolean {
  if (args.includes("--dry-run")) return false;
  if (remote) return true;
  if (
    args.some(
      (a) =>
        a === "--all-tables" ||
        a.startsWith("--all-tables") ||
        a === "--network",
    )
  )
    return true;
  // The replacement is the second positional: the URL the database will point at.
  const replacement = args.filter((a) => !a.startsWith("-"))[1];
  const host = replacement === undefined ? null : hostOf(replacement);
  return host !== null && !LOCAL_HOST.test(host);
}

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(
  segment: string,
  dir: string | null,
  pushed: Array<string | null>,
): Risk | Cd | null {
  const words = tokenize(
    segment
      .trim()
      .replace(/^[({]+\s*/, "")
      .replace(/\s*[)}]+$/, ""),
  );
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
    words.shift(); // leading VAR=value
  }
  if (words[0] === "sudo") {
    words.shift();
    while (words.length > 0 && words[0]!.startsWith("-")) {
      const option = words.shift()!;
      if (SUDO_VALUE_OPTIONS.has(option)) {
        words.shift();
      }
    }
  }
  while (
    words.length > 0 &&
    (PREFIXES.has(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))
  ) {
    words.shift();
  }
  if (words[0] === "nice") {
    words.shift();
    if ((words[0] as string | undefined) === "-n") {
      words.splice(0, 2);
    } else if (/^-\d+$/.test(words[0] ?? "")) {
      words.shift();
    }
  }
  const [first, ...args] = words;
  if (first === undefined) {
    return null;
  }
  const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm
  if (cmd === "cd") {
    return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
  }
  if (cmd === "pushd") {
    pushed.push(dir);
    return { cd: joinDir(dir, args[0]) };
  }
  if (cmd === "popd") {
    return { cd: pushed.length > 0 ? pushed.pop()! : "-" };
  }
  if (cmd === "rm" || cmd.endsWith("/rm")) {
    const flags = args.filter((a) => a.startsWith("-"));
    const recursive = flags.some(
      (f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)),
    );
    const force = flags.some(
      (f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")),
    );
    if (recursive || force) {
      const targets = args.filter((a) => !a.startsWith("-") || a === "-");
      return {
        kind: "rm",
        label: `rm ${flags.join(" ")}`.trim(),
        targets,
        dir,
      };
    }
  }
  if (cmd === "git") {
    // Git's own options come before the subcommand; -C moves where it runs.
    let gitDir = dir;
    let i = 0;
    while (i < args.length && args[i]!.startsWith("-")) {
      if (args[i] === "-C" && i + 1 < args.length) {
        gitDir = joinDir(gitDir, args[i + 1]);
        i += 2;
      } else if (args[i] === "-c" && i + 1 < args.length) {
        i += 2;
      } else {
        i += 1;
      }
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (sub === "reset" && rest.includes("--hard")) {
      return {
        kind: "git-reset",
        label: "git reset --hard",
        args: rest,
        dir: gitDir,
      };
    }
    if (sub === "clean") {
      return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
    }
    if (
      sub === "push" &&
      rest.some(
        (a) =>
          a === "--force" ||
          a === "-f" ||
          a.startsWith("--force-with-lease") ||
          /^\+/.test(a),
      )
    ) {
      return {
        kind: "git-push-force",
        label: "git push --force",
        args: rest,
        dir: gitDir,
      };
    }
    const stagedOnly =
      sub === "restore" &&
      rest.includes("--staged") &&
      !rest.includes("--worktree") &&
      !rest.includes("-W");
    if (
      (sub === "checkout" || sub === "restore") &&
      rest.includes(".") &&
      !stagedOnly
    ) {
      return {
        kind: "git-checkout",
        label: `git ${sub} -- .`,
        args: rest,
        dir: gitDir,
      };
    }
  }
  if (cmd === "wp" || cmd.endsWith("/wp")) {
    // `wp @alias ...` and `--ssh=` run on another host.
    const remote = args.some(
      (a) =>
        /^@[\w.-]+$/.test(a) ||
        a.startsWith("--ssh=") ||
        a.startsWith("--http="),
    );
    const [sub, sub2, ...rest] = args.filter(
      (a) => !/^@[\w.-]+$/.test(a) && !/^--(ssh|http|path|url)=/.test(a),
    );
    if (
      sub === "db" &&
      (sub2 === "reset" || sub2 === "drop" || sub2 === "import")
    ) {
      return {
        kind: "wp-db",
        label: `wp db ${sub2}`,
        args: [sub2, ...rest],
        dir,
      };
    }
    const srArgs = sub2 === undefined ? [] : [sub2, ...rest];
    if (sub === "search-replace" && riskySearchReplace(srArgs, remote)) {
      return {
        kind: "wp-search-replace",
        label: "wp search-replace",
        args,
        dir,
      };
    }
  }
  if (
    (cmd === "rsync" || cmd.endsWith("/rsync")) &&
    args.some((a) => /^--delete(-\w+)?$/.test(a) || a === "--del")
  ) {
    return { kind: "rsync-delete", label: "rsync --delete", args, dir };
  }
  const joined = words.join(" ");
  if (/\balembic\s+upgrade\b/.test(joined)) {
    return { kind: "migrate", tool: "alembic", label: "alembic upgrade", dir };
  }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) {
    return { kind: "migrate", tool: "rails", label: "db:migrate", dir };
  }
  if (/\bprisma\s+migrate\b/.test(joined)) {
    return { kind: "migrate", tool: "prisma", label: "prisma migrate", dir };
  }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) {
    return { kind: "migrate", tool: "django", label: "manage.py migrate", dir };
  }
  if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
    return { kind: "migrate", tool: "unknown", label: "migrate", dir };
  }
  return null;
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
export function tokenize(text: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3]!);
  }
  return words;
}

/** True when an rsync path argument names another host (`host:path`, `rsync://`). */
export function isRemotePath(arg: string): boolean {
  return /^rsync:\/\//.test(arg) || /^[^/]*:/.test(arg);
}
