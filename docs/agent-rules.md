# Agent rules

Rules for AI coding agents (Claude Code, Codex, Pi) in this repo, mined from past work sessions and reviewed (rules audit, 2026-10-21). Each rule keeps its ledger id. Global rules live in `~/.agents/rules/` and are not repeated here. If a rule here conflicts with an instruction from the user, the user wins.

- **R-command-guards-git-detection-01** When a guard cannot resolve a shell-dependent target path, first resolve git -C and cd targets, then fall back to the session directory; if that is not a repository either, block the command.
  _Why:_ Guards missed path-qualified commands or checked the wrong repository; unresolved probes must not pass as clean.
- **R-dotenv-serialization-round-trip-01** Serialize .env values with shell-safe quoting, decode the same escapes on read to preserve exact values, and treat only missing files as empty while propagating other read errors.
  _Why:_ Incorrect quoting changes sourced values and inconsistent parsing breaks round trips.
- **R-status-band-checks-01** Mark verification passed only after confirmed passing output; pending background checks and instruction-only skill calls do not count as completed checks.
  _Why:_ Dispatching a check or loading verification instructions does not establish a passing result.
