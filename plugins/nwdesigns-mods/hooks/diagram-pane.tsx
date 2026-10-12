// Ported from ray-amjad/claude-code-mods b75f32f, plugins/diagram-pane/hooks/register.js
// (MIT, Copyright (c) 2026 Ray Amjad; see NOTICE). Changes: TypeScript and
// JSX; the env overrides (DIAGRAM_PANE_EVERY, _SYNC, _DUMP) dropped; its own
// pane id; the store key named for this mod; fails open.
//
// diagram-pane: a side pane that keeps a picture of the work.
//
//   1. Pinned diagrams: every mermaid block or ASCII box diagram Claude writes
//      is pinned in the pane, newest first, drawn as boxes and arrows.
//   2. Live work map: every few turns (and on /diagram) a cheap Haiku gate asks
//      "did the work change shape?". Only on YES does a fork of the session
//      draw a small JSON graph of what Claude is doing right now.
//
// Output goes to the pane only. Nothing is sent back to Claude.

import type { EngineInterface, On, SessionMessage } from "claude-code";

import {
  drawGraph,
  findDiagrams,
  parseMermaid,
  short,
  type Diagram,
  type Graph,
} from "../lib/draw.ts";
import { msg } from "../lib/util.ts";

const PANE_ID = "diagram-pane";
const MAX_PINS = 5;
const STORE_KEY = "diagramMaps";

type Pin = Diagram & { graph: Graph | null; turn: number };
type WorkMap = { title: string; graph: Graph; turn: number };
type Saved = { map: WorkMap; mapAt: number; at: number };

// Everything the pane shows. Pins are rebuilt from the transcript; the map is
// also saved in $.store.
const S = {
  pins: [] as Pin[], // newest first
  seen: new Set<string>(), // the code of every diagram pinned so far
  scanned: 0, // how many transcript messages were already looked at
  turn: 0, // prompts the user sent in this session
  sinceMap: 0, // turns since the gate last ran
  map: null as WorkMap | null, // from the last fork
  mapAt: 0, // transcript length when the map was drawn
  note: "The map is drawn after a few turns, or now with /diagram",
  busy: false, // a gate or fork is running
};

// ---------------------------------------------------------------------------
// Pinned diagrams
// ---------------------------------------------------------------------------

// A turn is a prompt the user typed (tool results also arrive as user messages)
function turnsIn(messages: readonly SessionMessage[]): number {
  return messages.filter(
    (m) => m.role === "user" && m.text && !m.toolResults?.length,
  ).length;
}

function pinNewDiagrams(messages: readonly SessionMessage[]): void {
  if (messages.length < S.scanned) S.scanned = 0; // compacted: rescan, `seen` stops repeats
  messages.forEach((m, i) => {
    if (i < S.scanned || m.role !== "assistant") return;
    for (const d of findDiagrams(m.text)) {
      if (S.seen.has(d.code)) continue;
      S.seen.add(d.code);
      // Parse mermaid flowcharts into a graph; anything else is shown as written
      const graph = d.kind === "mermaid" ? parseMermaid(d.code) : null;
      S.pins.unshift({ ...d, graph, turn: turnsIn(messages.slice(0, i)) });
    }
  });
  S.scanned = messages.length;
  S.pins.length = Math.min(S.pins.length, MAX_PINS);
}

// ---------------------------------------------------------------------------
// Live work map: the gate, then the fork
// ---------------------------------------------------------------------------

const GATE_SYSTEM =
  "You watch a coding agent so a small diagram of its work stays current. Answer with exactly one word: YES or NO.";

const FORK_PROMPT = `[diagram-pane side request: not from the user. Do not continue the task and do not call tools.]
Draw a compact map of the work in this session right now: the files, components and steps involved, and how they connect.
Reply with ONLY one JSON object, no prose and no code fence:
{"title":"what the work is, max 40 chars","nodes":[{"id":"a","label":"max 20 chars","kind":"file|component|step","now":false}],"edges":[{"from":"a","to":"b","label":"optional, max 10 chars"}]}
Map the task, not the chat: steps are steps of the work ("add discount", "run tests"), never "read files" or "explain".
Rules: 3 to 8 nodes. Edges point from earlier to later, or from caller to callee, so the map reads top to bottom. At most 10 edges. Use file basenames as file labels. Set "now": true on the one node being worked on at this moment.`;

async function refreshMap(
  $: EngineInterface,
  messages: readonly SessionMessage[],
  force: boolean,
): Promise<void> {
  if (S.busy) return;
  S.busy = true;
  S.sinceMap = 0;
  try {
    // 1. The cheap gate: skipped only when there is no map yet, or on /diagram force
    if (S.map && !force) {
      S.note = "gate: checking if the work changed shape...";
      $.ui.invalidate("ui.render");
      const activity = messages.slice(S.mapAt);
      const gate = await $.model.complete({
        model: "haiku",
        system: GATE_SYSTEM,
        prompt:
          `CURRENT MAP: ${mapSummary(S.map)}\n\nFILES TOUCHED SINCE, NOT ON THE MAP: ${newFiles(S.map, activity).join(", ") || "none"}\n\n` +
          `ACTIVITY SINCE THE MAP WAS DRAWN:\n${digest(activity)}\n\n` +
          "Answer YES if the map is now out of date: the work touched files or components the map lacks, added a step " +
          "(such as tests, a new feature, a fix), or moved to a different task. Answer NO only if the map still shows the work. YES or NO?",
        maxTokens: 5,
        timeoutMs: 20000,
      });
      const yes = gate.isAnswered && /^\s*yes/i.test(gate.text);
      if (!yes) {
        S.note =
          `gate said same shape at turn ${S.turn}, map kept` +
          (gate.isAnswered ? "" : ` (${gate.reason})`);
        return;
      }
    }
    // 2. The fork: the session's own context, asked for JSON. It cannot call tools.
    S.note = "fork: drawing the work map...";
    $.ui.invalidate("ui.render");
    const r = await $.model.fork({ prompt: FORK_PROMPT });
    if (!r.isAnswered) {
      S.note =
        r.reason === "nothing-to-fork"
          ? "nothing to map yet: send a prompt first"
          : `fork failed: ${r.reason}`;
      return;
    }
    const map = parseMap(r.text);
    if (!map) {
      S.note = `fork reply was not a graph: ${short(r.text.replace(/\s+/g, " "), 60)}`;
      return;
    }
    S.map = { ...map, turn: S.turn };
    S.mapAt = messages.length;
    S.note = `map drawn at turn ${S.turn}`;
    await saveMap($);
  } catch (err) {
    S.note = `map error: ${msg(err)}`;
  } finally {
    S.busy = false;
    $.ui.invalidate("ui.render");
  }
}

// The fork's JSON becomes the same { nodes, edges } shape a mermaid chart parses to
function parseMap(text: string): { title: string; graph: Graph } | null {
  try {
    const json = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    ) as {
      title?: string;
      nodes?: Array<{
        id: unknown;
        label?: string;
        kind?: string;
        now?: boolean;
      }>;
      edges?: Array<{ from: unknown; to: unknown; label?: string }>;
    };
    const box = { file: "single", component: "round", step: "double" } as const;
    const nodes = (json.nodes || []).slice(0, 10).map((n) => ({
      id: String(n.id),
      label: (n.now ? "▶ " : "") + short(n.label || n.id, 22),
      box: box[n.kind as keyof typeof box] || "single",
    }));
    const edges = (json.edges || []).slice(0, 14).map((e) => ({
      from: String(e.from),
      to: String(e.to),
      label: short(e.label || "", 10),
    }));
    return nodes.length
      ? { title: short(json.title || "the work", 50), graph: { nodes, edges } }
      : null;
  } catch {
    return null;
  }
}

// The map is kept per session in the plugin's store, so it survives a reload or --resume
async function loadMap($: EngineInterface): Promise<void> {
  const maps = ((await $.store.get(STORE_KEY)) || {}) as Record<string, Saved>;
  const saved = maps[await $.session.id()];
  if (saved)
    Object.assign(S, {
      map: saved.map,
      mapAt: saved.mapAt,
      note: `map from turn ${saved.map.turn}`,
    });
}

async function saveMap($: EngineInterface): Promise<void> {
  const maps = ((await $.store.get(STORE_KEY)) || {}) as Record<string, Saved>;
  maps[await $.session.id()] = {
    map: S.map!,
    mapAt: S.mapAt,
    at: await $.clock.now(),
  };
  // Keep the 20 newest sessions only
  const keep = Object.entries(maps)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 20);
  await $.store.set(STORE_KEY, Object.fromEntries(keep));
}

function mapSummary(map: WorkMap): string {
  const { nodes, edges } = map.graph;
  const name = (id: string) => nodes.find((n) => n.id === id)?.label;
  return (
    `"${map.title}": ` +
    nodes.map((n) => n.label).join(", ") +
    "; " +
    edges.map((e) => `${name(e.from)} -> ${name(e.to)}`).join(", ")
  );
}

// Files Claude read, wrote or edited whose names the map does not mention
function newFiles(map: WorkMap, messages: readonly SessionMessage[]): string[] {
  const onMap = map.graph.nodes.map((n) => n.label).join(" ");
  const names = messages.flatMap((m) =>
    (m.toolUses || []).map((t) =>
      String(t.input?.file_path || "")
        .split("/")
        .pop(),
    ),
  );
  return [...new Set(names)].filter(
    (n): n is string => !!n && !onMap.includes(n),
  );
}

// What happened since the map was drawn, as short lines: prompts and tool calls
function digest(messages: readonly SessionMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.text && !m.toolResults?.length)
      lines.push("user: " + short(m.text.replace(/\s+/g, " "), 160));
    for (const t of m.toolUses || []) {
      const i = t.input || {};
      lines.push(
        `${t.tool}: ` +
          short(
            String(
              i.file_path ||
                i.path ||
                i.command ||
                i.pattern ||
                i.description ||
                "",
            ),
            100,
          ),
      );
    }
  }
  return lines.slice(-40).join("\n") || "(nothing)";
}

// ---------------------------------------------------------------------------
// What the pane draws
// ---------------------------------------------------------------------------

type Line = { text: string; color?: string; bold?: boolean; dim?: boolean };

// Lines of { text, color, bold, dim }, cut to `w` columns
function paneLines(w: number): Line[] {
  const out: Line[] = [];
  const add = (text: string, style: Omit<Line, "text"> = {}) =>
    out.push({ text, ...style });
  const rule = () => add("─".repeat(w), { dim: true });

  add(spread("◆ LIVE WORK MAP", S.map ? `turn ${S.map.turn}` : "", w), {
    bold: true,
    color: "cyan",
  });
  if (S.map) {
    add(S.map.title, { bold: true });
    for (const l of drawGraph(S.map.graph, w)) add(l, { color: "cyan" });
    add("┌ file   ╭ component   ╔ step   ▶ now", { dim: true });
  }
  add((S.busy ? "… " : "") + S.note, { dim: true });
  rule();

  add(
    spread(
      "◆ PINNED DIAGRAMS",
      S.pins.length ? `${S.pins.length} pinned` : "",
      w,
    ),
    { bold: true, color: "magenta" },
  );
  if (!S.pins.length)
    add("Mermaid or box diagrams Claude writes appear here.", { dim: true });
  S.pins.forEach((p, i) => {
    if (i) add("");
    const what = p.graph
      ? `flowchart, ${p.graph.nodes.length} boxes`
      : p.kind === "mermaid"
        ? "mermaid"
        : "box diagram";
    add(short(`${i + 1}. ${p.title || what} · turn ${p.turn}`, w), {
      bold: true,
    });
    if (p.graph) for (const l of drawGraph(p.graph, w)) add(l);
    else {
      // Not a flowchart we can draw: show the code as written, dimmed for mermaid
      if (p.kind === "mermaid")
        add("(raw mermaid: only flowcharts are drawn)", { dim: true });
      for (const l of p.code.split("\n")) add(l, { dim: p.kind === "mermaid" });
    }
  });
  return out;
}

function spread(left: string, right: string, w: number): string {
  return right
    ? left + " ".repeat(Math.max(1, w - left.length - right.length)) + right
    : left;
}

async function scan($: EngineInterface): Promise<readonly SessionMessage[]> {
  const messages = await $.session.messages();
  S.turn = turnsIn(messages);
  if (!S.map) await loadMap($);
  pinNewDiagrams(messages);
  return messages;
}

export function registerDiagramPane(on: On, every: number): void {
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    const started = await next(e);
    try {
      // Unasked, the pane is placed on a wide terminal (144+ columns);
      // /diagram opens it at any width.
      await $.ui.open({ id: PANE_ID, title: "Diagrams" });
      await $.command.register({
        name: "diagram",
        description: "Redraw the live work map in the diagram pane",
        argumentHint: "[force]",
      });
    } catch (err) {
      $.ui.log(`nwdesigns-mods diagram-pane: ${msg(err)}`);
    }
    return started;
  });

  // After each main turn: pin new diagrams, and every few turns refresh the map
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId || e.isAborted) return result;
    try {
      S.sinceMap += 1;
      const messages = await scan($);
      if (S.pins.length && !(await $.ui.panes()).some((p) => p.id === PANE_ID))
        await $.ui.open({ id: PANE_ID, title: "Diagrams" });
      // Not awaited: the turn never waits on the gate or the fork.
      if (S.sinceMap >= every) void refreshMap($, messages, false);
      $.ui.invalidate("ui.render");
    } catch (err) {
      $.ui.log(`nwdesigns-mods diagram-pane: ${msg(err)}`);
    }
    return result;
  });

  // /diagram runs the gate now; /diagram force skips the gate and always redraws
  on("command.run", { command: "diagram" }, async ($, e) => {
    try {
      await $.ui.open({ id: PANE_ID, title: "Diagrams" });
      void refreshMap($, await scan($), e.args.trim() === "force");
    } catch (err) {
      $.ui.log(`nwdesigns-mods diagram-pane: ${msg(err)}`);
    }
    return {};
  });

  // The pane itself: one Text per line, cut at the pane's width
  on("ui.render", { component: "Pane", requestId: PANE_ID }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const width = (e.props as { bodyColumns?: number }).bodyColumns || 60;
    return (
      <Box flexDirection="column">
        {paneLines(Math.max(30, width)).map((l) => (
          <Text
            color={l.color}
            bold={l.bold}
            dimColor={l.dim}
            wrap="truncate-end"
          >
            {l.text || " "}
          </Text>
        ))}
      </Box>
    );
  });
}
