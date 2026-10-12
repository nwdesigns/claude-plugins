// secret-box: the pure .env and git helpers. No runtime imports.
// Ported from ray-amjad/claude-code-mods b75f32f, plugins/secret-box/hooks/register.jsx
// (MIT, Copyright (c) 2026 Ray Amjad). Changes: split out of the hook file,
// typed, `export NAME=` lines matched too.

// .env, .env.local, .env.production ... but not .env.example and friends.
export function isEnvFile(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return (
    /^\.env(\.[\w.-]+)?$/.test(base) &&
    !/\.(example|sample|template|dist)$/.test(base)
  );
}

// Plain values stay bare. Others get single quotes, which `source .env` reads
// literally ($, backticks and \ included). A value with a ' gets double
// quotes with \ " $ ` escaped; parseEnv decodes the same four. The box is one
// line, so a value has no newline.
function quote(v: string): string {
  if (/^[A-Za-z0-9_\-./:+=@]*$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

// The .env text with NAME set to value: its line replaced, else appended.
export function upsertEnv(text: string, name: string, value: string): string {
  const line = `${name}=${quote(value)}`;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const re = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  const at = lines.findIndex((l) => re.test(l));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return `${lines.join("\n")}\n`;
}

// The .gitignore text with .env added, or null when it is already ignored.
export function ensureIgnored(text: string): string | null {
  const ignored = text
    .split("\n")
    .some((l) => [".env", ".env*", "*.env", "/.env"].includes(l.trim()));
  if (ignored) return null;
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}.env\n`;
}

// A command that stages a .env file by name. `git add -A` is caught at the
// commit, by the staged list.
export function stagesEnv(command: string): boolean {
  return (
    /\bgit\b[^;&|]*\badd\b/.test(command) &&
    /\.env\b(?!\.(example|sample|template|dist))/.test(command)
  );
}

export const isCommit = (command: string) =>
  /\bgit\b[^;&|]*\bcommit\b/.test(command);
// `git commit -a` also takes the unstaged tracked changes.
export const commitsAll = (command: string) =>
  /\s(-a|--all|-\w*a\w*)\b/.test(command);
