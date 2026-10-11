// effort: when a model request of the main loop runs at xhigh by itself.

export type EffortState = { mode: string; userSet: boolean };

// Plan mode, the main loop, and no /effort typed this session (an explicit
// /effort always wins). A request already at max stays at max.
export function raise(
  s: EffortState | null,
  agentId: string | undefined,
  current: unknown,
): boolean {
  return (
    !!s && s.mode === "plan" && !s.userSet && !agentId && current !== "max"
  );
}
