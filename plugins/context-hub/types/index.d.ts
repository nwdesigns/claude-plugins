// Session state of the hub mod: headers and cursor only. Message text and the token never go here.
export type HubKind =
  "handoff" | "question" | "confirmation" | "answer" | "correction";
export type HubHeader = {
  seq: number;
  id?: string;
  kind: HubKind;
  from: string;
  project: string;
  at: number;
};

declare module "claude-code" {
  interface PluginState {
    "context-hub": {
      cursor: number | null;
      events: HubHeader[];
      unread: number;
      bandHidden: boolean;
      status: string;
    };
  }
}
