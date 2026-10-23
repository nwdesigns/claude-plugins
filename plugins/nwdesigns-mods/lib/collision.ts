// collision-guard: pure part. Claude Code itself refuses a Write or Edit to a
// file that changed after the last Read; this part words that refusal so the
// agent goes on alone, with a diff of the other writer's change.

// Claude Code's text for a stale Write/Edit (2.1.309): "File has been
// modified since read, either by the user or by a linter. Read it again
// before attempting to write it."
export const STALE = /modified since read/i;

// No snapshot (and so no diff) for files that can hold secrets: a diff of an
// old version can show a value that the redactor no longer matches.
export const SECRET_NAME =
  /(^|\/)(\.env[^/]*|[^/]*(secret|credential|password)[^/]*|[^/]*\.(pem|key|p12))$/i;

export const MAX_LINES = 120;
export const MAX_CHARS = 8192;

// Cut a unified diff at MAX_LINES lines or MAX_CHARS characters, with a marker.
export function capDiff(diff: string): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let size = 0;
  // ponytail: counts characters, not bytes; close enough for a context cap.
  for (const line of lines.slice(0, MAX_LINES)) {
    size += line.length + 1;
    if (size > MAX_CHARS) break;
    out.push(line);
  }
  const text = out.join("\n");
  return out.length < lines.length ? `${text}\n(truncated, read the file)` : text;
}

// The deny text that replaces Claude Code's stale refusal.
export function staleMessage(
  native: string,
  path: string,
  diff: string | undefined,
): string {
  const body = diff ? capDiff(diff) : "(no diff available)";
  return (
    `collision-guard: Read ${path} again, then re-apply your change on the current text. ` +
    "Another agent, session or editor changed it after you last read it. " +
    "Not an error in your edit, no approval needed. " +
    "If the diff below already contains your change, skip it.\n" +
    `Claude Code: ${native.replace(/<\/?tool_use_error>/g, "").trim()}\n` +
    `--- changed since your last read ---\n${body}`
  );
}
