// collision-guard: pure part. Advisory, not a lock: mtime does not prove who
// wrote the file.

// ponytail: a change up to 10 s after this session's own write counts as its
// own (the php-cs-fixer post-write hook), so a real concurrent edit in those
// 10 s goes unseen; record the formatter's write if that matters.
export const OWN_GRACE_MS = 10_000;

// True when the mtime falls inside one of this session's Bash runs [start, end]
// (plus the grace): a sed, a heredoc, a formatter or a git checkout of its own.
// ponytail: another writer that changes the file during our Bash run also
// counts as own; per-file tracking needs a filesystem watcher.
export function duringOwnRun(
  mtimeMs: number,
  runs: readonly (readonly [number, number])[],
): boolean {
  return runs.some(
    ([start, end]) => mtimeMs >= start - 1000 && mtimeMs <= end + OWN_GRACE_MS,
  );
}

// True when the file changed inside the window and the change is not this
// session's last write.
export function foreign(
  mtimeMs: number,
  ownMtimeMs: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  if (now - mtimeMs > windowMs) return false;
  if (ownMtimeMs === undefined) return true;
  return mtimeMs - ownMtimeMs > OWN_GRACE_MS || mtimeMs < ownMtimeMs;
}
