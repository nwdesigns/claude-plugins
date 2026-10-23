// The $.state contract of nwdesigns-mods: every value is the session's.

// mode: the permission mode of the last prompt; userSet: /effort typed this session.
export type NwdesignsModsEffort = { mode: string; userSet: boolean };

declare module "claude-code" {
  interface PluginState {
    "nwdesigns-mods": {
      edits: number; // edits since the last passed check
      gen: number; // monotonic edit generation, never reset
      checked: boolean;
      denied: number; // main-loop tool calls denied in the running turn
      context: number; // the last main-thread context fill, in percent
      rec: boolean;
      effort: NwdesignsModsEffort | null;
    };
  }
}
