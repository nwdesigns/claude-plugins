// Ported from ray-amjad/claude-code-mods b75f32f, plugins/diagram-pane/hooks/draw.js
// (MIT, Copyright (c) 2026 Ray Amjad). Changes: TypeScript types only.
//
// draw: turns diagrams into lines of terminal text. No $ here, just strings.
//
//   findDiagrams(markdown)   -> the mermaid and ASCII diagrams in a reply
//   parseMermaid(code)       -> { nodes, edges } for a flowchart, or null
//   drawGraph(graph, width)  -> lines of box-and-arrow text, top to bottom

export type BoxKind = "single" | "round" | "double";
export type GraphNode = { id: string; label: string; box: BoxKind | "" };
export type GraphEdge = { from: string; to: string; label: string };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };
export type Diagram = {
  kind: "mermaid" | "ascii";
  code: string;
  title: string;
};

// ---------------------------------------------------------------------------
// 1. Find diagrams in a reply
// ---------------------------------------------------------------------------

const CORNERS = /[┌┐└┘╭╮╰╯╔╗╚╝]|\+[-=]{3,}/;
const ARROWS = /(--+>|──+[>▶]|→|▶|▼|↓|\^)/;
const PLAIN = ["", "text", "txt", "ascii", "plain", "diagram", "art"];

// Returns [{ kind: 'mermaid' | 'ascii', code, title }] in reply order
export function findDiagrams(markdown: string): Diagram[] {
  const found: Diagram[] = [];
  const fence = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown))) {
    const lang = m[1]!.toLowerCase();
    const code = m[2]!.replace(/\s+$/, "");
    const title = titleBefore(markdown.slice(0, m.index));
    if (lang === "mermaid") found.push({ kind: "mermaid", code, title });
    else if (PLAIN.includes(lang) && looksLikeBoxes(code))
      found.push({ kind: "ascii", code, title });
  }
  return found;
}

// An ASCII diagram has box corners, or several lines of arrows
function looksLikeBoxes(code: string): boolean {
  const lines = code.split("\n");
  const corners = lines.filter((l) => CORNERS.test(l)).length;
  const arrows = lines.filter((l) => ARROWS.test(l)).length;
  return corners >= 2 || (arrows >= 2 && lines.length <= 40);
}

// A heading, or a line ending in ':', just before the diagram makes a good title
function titleBefore(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .reverse();
  const pick = lines.find((l) => /^#+\s/.test(l) || /:\**$/.test(l));
  if (!pick || pick.startsWith("```")) return "";
  return pick
    .replace(/^#+\s*/, "")
    .replace(/^[-*\d.]+\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/:$/, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// 2. Parse a mermaid flowchart into nodes and edges
// ---------------------------------------------------------------------------

// Shape openers, longest first, with their closer and the box we draw for them
const SHAPES: Array<[string, string, BoxKind]> = [
  ["([", "])", "round"],
  ["[[", "]]", "single"],
  ["[(", ")]", "round"],
  ["((", "))", "round"],
  ["{{", "}}", "double"],
  ["[/", "/]", "single"],
  ["[\\", "\\]", "single"],
  [">", "]", "single"],
  ["[", "]", "single"],
  ["(", ")", "round"],
  ["{", "}", "double"],
];
// Edge operators: an optional label in the middle (-- yes -->) or in pipes (-->|yes|)
const EDGE_MID =
  /^\s*(?:<)?(?:--|-\.|==)\s+([^|>]+?)\s+(?:-->|--[ox]|---|\.->|-\.-|==>|===)/;
const EDGE =
  /^\s*(?:<)?(?:-\.+->|-\.+-|--+>|--+[ox]|---+|==+>|===+|~~~)(?:\|([^|]*)\|)?/;
const SKIP =
  /^(subgraph|end|classDef|class|style|linkStyle|click|direction|%%|accTitle|accDescr)\b/;

export function parseMermaid(code: string): Graph | null {
  const stmts = code
    .split(/[\n;]/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!/^(graph|flowchart)\b/i.test(stmts[0] || "")) return null;
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (const stmt of stmts.slice(1))
    if (!SKIP.test(stmt)) parseStatement(stmt, nodes, edges);
  if (!nodes.size) return null;
  return { nodes: [...nodes.values()], edges };
}

// A statement is: group (edge group)*, where a group is node (& node)*
function parseStatement(
  stmt: string,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
): void {
  let rest = stmt;
  let prev: { ids: string[]; label: string } | null = null;
  while (rest.trim()) {
    const group: string[] = [];
    for (;;) {
      const n = readNode(rest);
      if (!n) return;
      rest = n.rest;
      const known = nodes.get(n.id);
      if (!known)
        nodes.set(n.id, {
          id: n.id,
          label: n.label || n.id,
          box: n.box || "single",
        });
      else if (n.label) Object.assign(known, { label: n.label, box: n.box });
      group.push(n.id);
      const amp = rest.match(/^\s*&\s*/);
      if (!amp) break;
      rest = rest.slice(amp[0].length);
    }
    if (prev)
      for (const from of prev.ids)
        for (const to of group) edges.push({ from, to, label: prev.label });
    const e = rest.match(EDGE_MID) || rest.match(EDGE);
    if (!e) return;
    prev = { ids: group, label: clean(e[1] || "") };
    rest = rest.slice(e[0].length);
  }
}

function readNode(
  text: string,
): { id: string; label: string; box: BoxKind | ""; rest: string } | null {
  const m = text.match(/^\s*([\w]+)/);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  for (const [open, close, box] of SHAPES) {
    if (!rest.startsWith(open)) continue;
    let body = rest.slice(open.length);
    let label: string | undefined;
    const quoted = body.match(/^\s*"([^"]*)"\s*/);
    if (quoted) {
      label = quoted[1];
      body = body.slice(quoted[0].length);
    }
    const end = body.indexOf(close);
    if (end < 0) return null;
    if (label === undefined) label = body.slice(0, end);
    return {
      id: m[1]!,
      label: clean(label),
      box,
      rest: body.slice(end + close.length),
    };
  }
  return { id: m[1]!, label: "", box: "", rest };
}

function clean(s: string): string {
  return s
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------
// 3. Draw a graph as boxes and arrows, top to bottom, in `width` columns
// ---------------------------------------------------------------------------

type BoxStyle = {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  out: string;
};
const BOX: Record<BoxKind, BoxStyle> = {
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", out: "┬" },
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", out: "┬" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", out: "╤" },
};
// A connector cell remembers which way its lines go: up, down, left, right
const U = 1,
  D = 2,
  L = 4,
  R = 8;
const JOIN: Record<number, string> = {
  [U | D]: "│",
  [L | R]: "─",
  [D | R]: "┌",
  [D | L]: "┐",
  [U | R]: "└",
  [U | L]: "┘",
  [U | D | R]: "├",
  [U | D | L]: "┤",
  [D | L | R]: "┬",
  [U | L | R]: "┴",
  [U | D | L | R]: "┼",
  [U]: "│",
  [D]: "│",
  [L]: "─",
  [R]: "─",
};

type Placed = {
  n: GraphNode;
  lines: string[];
  w: number;
  h: number;
  x: number;
  y: number;
  row: number;
  cx: number;
};

// graph: { nodes: [{ id, label, box }], edges: [{ from, to, label }] }
export function drawGraph(graph: Graph, width: number): string[] {
  const nodes = graph.nodes;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to,
  );
  const layer = layers(nodes, edges);
  const rows = displayRows(nodes, edges, layer, width);

  // Measure every box, then place the rows one under another
  const place = new Map<string, Placed>();
  let y = 0;
  const routed = new Set<GraphEdge>();
  const gaps: Array<{ y: number; edges: GraphEdge[] }> = [];
  rows.forEach((row, r) => {
    // Labels get 22 columns when the row has room, else 16 (what displayRows packed for)
    const roomy =
      row.reduce((s, n) => s + Math.min(longest(n.label), 22) + 6, -2) <= width;
    const boxes = row.map((n) => {
      const lines = wrap(n.label, roomy ? 22 : 16);
      return {
        n,
        lines,
        w: Math.max(...lines.map((l) => l.length)) + 4,
        h: lines.length + 2,
      };
    });
    const total = boxes.reduce((s, b) => s + b.w, 0) + (boxes.length - 1) * 2;
    let x = Math.max(0, Math.floor((width - total) / 2));
    for (const b of boxes) {
      place.set(b.n.id, { ...b, x, y, row: r, cx: x + Math.floor(b.w / 2) });
      x += b.w + 2;
    }
    y += Math.max(...boxes.map((b) => b.h));
    // Edges from this row straight to the next one get a 3-line gap to run in
    const next = new Set((rows[r + 1] || []).map((n) => n.id));
    const down = edges.filter(
      (e) => row.some((n) => n.id === e.from) && next.has(e.to),
    );
    down.forEach((e) => routed.add(e));
    if (r < rows.length - 1) {
      gaps.push({ y, edges: down });
      y += down.length ? 3 : 1;
    }
  });

  // Paint onto a grid: boxes as characters, connectors as direction bits
  const grid = Array.from({ length: y }, () =>
    Array.from({ length: width }, () => ({ ch: " ", bits: 0 })),
  );
  const put = (gy: number, gx: number, ch: string) => {
    const c = grid[gy]?.[gx];
    if (c) c.ch = ch;
  };
  const bit = (gy: number, gx: number, b: number) => {
    const c = grid[gy]?.[gx];
    if (c) c.bits |= b;
  };
  for (const p of place.values()) {
    const s = BOX[p.n.box || "single"] || BOX.single;
    put(p.y, p.x, s.tl);
    put(p.y, p.x + p.w - 1, s.tr);
    put(p.y + p.h - 1, p.x, s.bl);
    put(p.y + p.h - 1, p.x + p.w - 1, s.br);
    for (let i = 1; i < p.w - 1; i++) {
      put(p.y, p.x + i, s.h);
      put(p.y + p.h - 1, p.x + i, s.h);
    }
    p.lines.forEach((line, i) => {
      put(p.y + 1 + i, p.x, s.v);
      put(p.y + 1 + i, p.x + p.w - 1, s.v);
      [...line.padEnd(p.w - 4)].forEach((c, j) =>
        put(p.y + 1 + i, p.x + 2 + j, c),
      );
    });
  }
  const labels: Array<{ e: GraphEdge; y: number; x: number }> = [];
  for (const g of gaps) {
    for (const e of g.edges) {
      const a = place.get(e.from)!,
        b = place.get(e.to)!;
      const s = BOX[a.n.box || "single"] || BOX.single;
      // Enter straight down when the source sits above the target, else at its centre
      const tx = a.cx > b.x + 1 && a.cx < b.x + b.w - 2 ? a.cx : b.cx;
      put(a.y + a.h - 1, a.cx, s.out); // the line leaves the box's bottom edge
      for (let y = a.y + a.h; y <= g.y; y++) bit(y, a.cx, U | D); // down past shorter boxes
      bit(g.y + 1, a.cx, U); // turn onto the bus row
      for (let x = Math.min(a.cx, tx); x < Math.max(a.cx, tx); x++) {
        bit(g.y + 1, x, R);
        bit(g.y + 1, x + 1, L);
      }
      bit(g.y + 1, tx, D);
      put(g.y + 2, tx, "▼"); // and points into the target
      if (e.label) labels.push({ e, y: g.y + 2, x: tx + 1 });
    }
  }
  // Labels go beside their arrow once every arrow is down, so none covers another
  const notes: GraphEdge[] = [];
  for (const { e, y, x } of labels) {
    const text = " " + short(e.label, 14) + " ";
    const free = [...text].every((_, j) => grid[y]?.[x + j]?.ch === " ");
    if (free) [...text.trimEnd()].forEach((c, j) => put(y, x + j, c));
    else notes.push(e);
  }
  const out = grid.map((row) =>
    row
      .map((c) => (c.ch === " " && c.bits ? JOIN[c.bits] : c.ch))
      .join("")
      .trimEnd(),
  );

  // Edges we could not route straight down are listed under the drawing
  const label = (id: string) =>
    short(nodes.find((n) => n.id === id)!.label, 18);
  for (const e of edges)
    if (!routed.has(e) || notes.includes(e)) {
      const back = layer.get(e.to)! <= layer.get(e.from)!;
      out.push(
        short(
          `  ${back ? "↺" : "⇢"} ${label(e.from)} → ${label(e.to)}${e.label ? "  (" + e.label + ")" : ""}`,
          width,
        ),
      );
    }
  return out;
}

// Longest-path layers, after dropping the edges that close a cycle
function layers(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const state = new Map<string, number>();
  const forward: GraphEdge[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of edges.filter((e) => e.from === id)) {
      if (state.get(e.to) === 1) continue; // a back edge: skip it for layering
      forward.push(e);
      if (!state.get(e.to)) visit(e.to);
    }
    state.set(id, 2);
  };
  nodes.forEach((n) => {
    if (!state.get(n.id)) visit(n.id);
  });
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of forward)
      if (layer.get(e.to)! < layer.get(e.from)! + 1) {
        layer.set(e.to, layer.get(e.from)! + 1);
        moved = true;
      }
    if (!moved) break;
  }
  return layer;
}

// Group nodes by layer, order each layer under its parents, and split a layer
// that is too wide for the pane into several rows
function displayRows(
  nodes: GraphNode[],
  edges: GraphEdge[],
  layer: Map<string, number>,
  width: number,
): GraphNode[][] {
  const depth = Math.max(...layer.values());
  const pos = new Map<string, number>();
  const rows: GraphNode[][] = [];
  for (let d = 0; d <= depth; d++) {
    const these = nodes.filter((n) => layer.get(n.id) === d);
    const centre = (n: GraphNode) => {
      const ps = edges
        .filter((e) => e.to === n.id && pos.has(e.from))
        .map((e) => pos.get(e.from)!);
      return ps.length
        ? ps.reduce((a, b) => a + b, 0) / ps.length
        : nodes.indexOf(n);
    };
    these.sort((a, b) => centre(a) - centre(b));
    these.forEach((n, i) => pos.set(n.id, i));
    // Fill a row while the boxes fit side by side (labels up to 16 wide), then start another
    let row: GraphNode[] = [],
      used = 0;
    for (const n of these) {
      const w = Math.min(longest(n.label), 16) + 4 + (row.length ? 2 : 0);
      if (row.length && used + w > width) {
        rows.push(row);
        row = [];
        used = 0;
      }
      row.push(n);
      used += w;
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

// Word-wrap a label into at most 3 lines of `w` columns
function wrap(text: string, w: number): string[] {
  const lines: string[] = [];
  // A <br> in a mermaid label is a line break we keep
  for (const part of String(text).split("\n")) {
    let cur = "";
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const piece = word.length > w ? word.slice(0, w - 1) + "…" : word;
      if (!cur) cur = piece;
      else if ((cur + " " + piece).length <= w) cur += " " + piece;
      else {
        lines.push(cur);
        cur = piece;
      }
    }
    if (cur) lines.push(cur);
  }
  if (lines.length > 3) {
    lines.length = 3;
    lines[2] = short(lines[2] + " …", w);
  }
  return lines.length ? lines : ["?"];
}

export function short(s: unknown, n: number): string {
  const t = String(s).replace(/\n/g, " ");
  return t.length <= n ? t : t.slice(0, Math.max(1, n - 1)) + "…";
}

const longest = (label: string) =>
  Math.max(
    ...String(label)
      .split("\n")
      .map((l) => l.length),
  );
