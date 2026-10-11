# claude-plugins

The nwdesigns plugin marketplace for Claude Code.

## Plugins

| Plugin | What it does |
|---|---|
| [nwdesigns-mods](plugins/nwdesigns-mods/README.md) | Secret redaction, Blast Radius, collision guard, recording mode, completion check, plan-mode effort and a status band |

Install:

```
claude plugin marketplace add nwdesigns/claude-plugins
claude plugin install nwdesigns-mods@nwdesigns --scope user
```

## Recommended third-party mods

These mods are not ours. Read their README before you install them.

| Mod | Install | Note |
|---|---|---|
| File Tree | `claude plugin marketplace add data-goblin/claude-code-filetree`, then `claude plugin install filetree@claude-code-filetree` | A file tree with git status beside the transcript. Needs `/tui fullscreen` and 110+ columns. |
| Cache Tax | `claude plugin marketplace add karanb192/claude-code-mods`, then `claude plugin install cache-tax@claude-code-mods` | Shows the prompt cache state; `/keepwarm` keeps it warm. Set `/cache-tax guard warn`, so a message is never dropped. |
| Replay Theater | Clone `anthropics/claude-code-playground`, then `claude plugin marketplace add ./claude-code/mods` and `claude plugin install replay-theater@claude-code-playground-mods` | `/replay` steps through the edits of the last turn. |

The upstream Blast Radius in `anthropics/claude-code-playground` is an alternative to the copy in nwdesigns-mods. Do not install both: each one holds the same commands.

## The old context-hub plugin

The `context-hub` plugin was removed on 2026-10-10. The nwdesigns hub needs no plugin: connect to it directly (see below).

### Remove it

```
claude plugin uninstall context-hub@nwdesigns
codex plugin remove context-hub@nwdesigns
```

If you enabled desktop notices, also stop the notify unit:

- macOS: `launchctl bootout gui/$(id -u)/it.nwdesigns.context-hub-notify`, then delete `~/Library/LaunchAgents/it.nwdesigns.context-hub-notify.plist`.
- Linux: `systemctl --user disable --now context-hub-notify`.

### Connect to the hub

The hub is one MCP server: `https://hub.nwdesigns.it/mcp`. Sign in with your nwdesigns.it Google account.

- Claude app: Settings → Connectors → add a custom connector with the URL above.
- Claude Code: `claude mcp add --transport http --scope user nwdesigns https://hub.nwdesigns.it/mcp`, then `/mcp` to sign in.
- Codex: `codex mcp add nwdesigns --url https://hub.nwdesigns.it/mcp`, then `codex mcp login nwdesigns --scopes hub:read,hub:write,offline_access`.

The plugin source stays in the git history of this repo.

## License

Apache-2.0, see `LICENSE`. See [CONTRIBUTING.md](CONTRIBUTING.md) to add a plugin.
