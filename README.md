# claude-plugins

The `context-hub` plugin was removed on 2026-10-10. The nwdesigns hub needs no plugin: connect to it directly.

## Remove the old plugin

```
claude plugin uninstall context-hub@nwdesigns
claude plugin marketplace remove nwdesigns
codex plugin remove context-hub@nwdesigns
codex plugin marketplace remove nwdesigns
```

If you enabled desktop notices, also stop the notify unit:

- macOS: `launchctl bootout gui/$(id -u)/it.nwdesigns.context-hub-notify`, then delete `~/Library/LaunchAgents/it.nwdesigns.context-hub-notify.plist`.
- Linux: `systemctl --user disable --now context-hub-notify`.

## Connect to the hub

The hub is one MCP server: `https://hub.nwdesigns.it/mcp`. Sign in with your nwdesigns.it Google account.

- Claude app: Settings → Connectors → add a custom connector with the URL above.
- Claude Code: `claude mcp add --transport http --scope user nwdesigns https://hub.nwdesigns.it/mcp`, then `/mcp` to sign in.
- Codex: `codex mcp add nwdesigns --url https://hub.nwdesigns.it/mcp`, then `codex mcp login nwdesigns --scopes hub:read,hub:write,offline_access`.

The plugin source stays in the git history of this repo.
