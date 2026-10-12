import type { Register } from "claude-code";

import { bool, pick } from "../lib/util.ts";
import { registerBlastRadius } from "./blast-radius.tsx";
import { registerCollisionGuard } from "./collision-guard.ts";
import { registerCompletionCheck } from "./completion-check.ts";
import { registerDiagramPane } from "./diagram-pane.tsx";
import { registerPlanEffort } from "./plan-effort.ts";
import { registerPromptBouncer } from "./prompt-bouncer.ts";
import { registerRecording } from "./recording.tsx";
import { registerSecretBox } from "./secret-box.tsx";
import { registerSecretRedact } from "./secret-redact.ts";
import { registerStatusBand } from "./status-band.tsx";

// nwdesigns-mods: the team's safety and hygiene mods. One userConfig option
// per mod. Every mod fails open (a throw, an overrun or a wrong-shaped answer
// skips the hook), except secret-redact, which withholds a result it cannot
// redact.
//
// Validator rules that shape the files: `$` is never passed across an
// import (each mod file holds its own hooks), and an event has at most one
// unmatched hook in the whole plugin (the others carry a matcher).

// extraSecretFiles, bouncerDocs: a list, or one string of paths split on commas.
function paths(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list.map((p) => String(p).trim()).filter(Boolean);
}

export const register: Register = (on, options) => {
  // First, so outermost in this plugin: it sees the result every other mod
  // here hands back, deny texts included.
  if (bool(options.secretRedact, true))
    registerSecretRedact(on, paths(options.extraSecretFiles));
  if (bool(options.blastRadius, true)) registerBlastRadius(on);
  if (bool(options.statusBand, true)) registerStatusBand(on);
  if (bool(options.collisionGuard, true)) {
    const minutes = Number(options.collisionMinutes);
    registerCollisionGuard(on, minutes > 0 ? minutes : 10);
  }
  if (bool(options.recording, true)) registerRecording(on);
  const completion = pick(
    options.completionCheck,
    ["off", "shadow", "block"] as const,
    "shadow",
  );
  if (completion !== "off") registerCompletionCheck(on, completion);
  if (bool(options.planXhigh, true)) registerPlanEffort(on);
  if (bool(options.secretBox, true)) registerSecretBox(on);
  const bouncer = pick(
    options.promptBouncer,
    ["off", "warn", "block"] as const,
    "warn",
  );
  if (bouncer !== "off") {
    const max = Number(options.bouncerMaxChars);
    const docs = paths(options.bouncerDocs);
    registerPromptBouncer(on, {
      mode: bouncer,
      docs: docs.length ? docs : ["GLOSSARY.md", "CLAUDE.md"],
      maxChars: max > 0 ? max : 20000,
    });
  }
  if (bool(options.diagramPane, false)) {
    const every = Number(options.diagramEveryTurns);
    registerDiagramPane(on, every > 0 ? every : 3);
  }
};
