// Shared by every mod. No runtime imports.

// The API is pre-contract: a renamed method throws a TypeError where it is
// first called. Every `$` call sits in a try/catch whose log line goes
// through msg(), and such a TypeError gets the MISSING API mark.
export function msg(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return err instanceof TypeError && /is not a function|of undefined/.test(text)
    ? `MISSING API? ${text}`
    : text;
}

// Options typed by hand in settings.json can arrive as strings.
export function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

export function pick<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

// Absolute path the way the harness resolves file_path (~ and cwd-relative).
export function resolvePath(file: string, home: string, cwd: string): string {
  if (file.startsWith("~/")) return `${home}/${file.slice(2)}`;
  if (file.startsWith("/")) return file;
  return `${cwd.replace(/\/$/, "")}/${file}`;
}
