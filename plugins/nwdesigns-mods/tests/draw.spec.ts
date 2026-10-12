// Ported from ray-amjad/claude-code-mods b75f32f, plugins/diagram-pane/tests/draw.test.ts
// (MIT, Copyright (c) 2026 Ray Amjad). Changes: bun:test, the lib/draw.ts path.
import { expect, test } from "bun:test";
import { drawGraph, findDiagrams, parseMermaid } from "../lib/draw.ts";

const reply =
  "The flow:\n\n```mermaid\nflowchart TD\n  A[Cart] -->|total| B{Over 200?}\n  B -- yes --> C[Discount]\n  B -- no --> D[Pay]\n  C --> D\n```\n\n```bash\nls -> out\n```\n";

test("finds the mermaid block and skips a bash block", () => {
  const found = findDiagrams(reply);
  expect(found.length).toBe(1);
  expect(found[0]!.kind).toBe("mermaid");
  expect(found[0]!.title).toBe("The flow");
});

test("finds an ASCII box diagram in a plain code block", () => {
  const found = findDiagrams(
    "```\n┌───┐   ┌───┐\n│ a │──▶│ b │\n└───┘   └───┘\n```",
  );
  expect(found.length).toBe(1);
  expect(found[0]!.kind).toBe("ascii");
});

test("parses nodes, shapes and edge labels", () => {
  const g = parseMermaid(findDiagrams(reply)[0]!.code)!;
  expect(g.nodes.map((n) => n.label)).toEqual([
    "Cart",
    "Over 200?",
    "Discount",
    "Pay",
  ]);
  expect(g.nodes[1]!.box).toBe("double");
  expect(g.edges.map((e) => e.label)).toEqual(["total", "yes", "no", ""]);
});

test("draws boxes and arrows inside the width", () => {
  const lines = drawGraph(parseMermaid(findDiagrams(reply)[0]!.code)!, 40);
  expect(lines.every((l) => l.length <= 40)).toBe(true);
  expect(lines.join("\n")).toContain("│ Cart │");
  expect(lines.join("\n")).toContain("▼ yes");
});
