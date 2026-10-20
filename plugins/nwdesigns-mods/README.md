# nwdesigns-mods

Safety and hygiene mods for Claude Code, for the nwdesigns team. Each mod runs inside Claude Code. Each mod has its own on/off switch.

## Install

You need Claude Code 2.1.296 or later (`$.tool.register` and `$.model.fork`). No environment flag is necessary.

```
claude plugin marketplace add nwdesigns/claude-plugins
claude plugin install nwdesigns-mods@nwdesigns --scope user
```

Change a switch with `/config`, or in `~/.claude/settings.json`:

```json
"pluginConfigs": {
  "nwdesigns-mods@nwdesigns": {
    "options": { "completionCheck": "off" }
  }
}
```

Remove the plugin with `claude plugin uninstall nwdesigns-mods@nwdesigns --scope user`.

## The mods

### Secret redaction (`secretRedact`)

- **What you see:** `[REDACTED:DB_PASS]` in place of a secret value in a command output or a file that Claude reads.
- **When:** on every tool result. It uses the values in the project `.env`, `.env.local` and `.env.production`, and known token formats (GitHub, OpenAI, Anthropic, AWS, Slack, JWT, private keys, passwords in URLs).
- **More files:** set `extraSecretFiles` to a comma list of paths, for example `~/.config/me/secrets.env, ~/.codex/auth.json`. A `.json` file is read as JSON.
- **Turn off:** `"secretRedact": false`.
- **Limits:** it does not cover what Claude types into a command, an unknown token format, or a secret that is split or encoded. If a file in `extraSecretFiles` cannot be read and no earlier values are in memory, every tool result is withheld until you fix the file or the setting.

### Secret Box (`secretBox`)

- **What you see:** when Claude needs a secret, it asks with the `request_secret` tool. A masked box opens. You type or paste the value and press Enter. The value goes to the project `.env`, and `.env` goes to `.gitignore` if it is not there. Claude gets the variable name only.
- **When:** Claude calls the tool, or you ask Claude to "ask me for the Stripe key with secret box". `git add .env`, a commit with `.env` staged, and `@.env` in a prompt are refused.
- **Turn off:** `"secretBox": false`.
- **Limits:** Esc or an empty Enter cancels. If nobody answers in 10 minutes, nothing is saved. Secret redaction hides the saved value in later tool results. `git add -A && git commit` in one command is not caught, because the staged list is read before the command runs. If the terminal is too narrow for the pane, the box shows in the band above the prompt.

### Blast Radius (`blastRadius`)

- **What you see:** a pane that shows what a risky command will change, with **Proceed** (key 1) and **Cancel** (key 2). Cancel has the focus.
- **When:** `rm -r`/`rm -f`, `git reset --hard`, `git checkout -- .`, `git restore .`, `git clean`, a force push, a migration, `wp db reset|drop|import`, `wp search-replace` (see Limits), `rsync --delete`.
- **Turn off:** `"blastRadius": false`. In bypass permissions mode (`cld`, `--dangerously-skip-permissions`) it holds nothing: the command runs at once and a toast names it, so a long automated session does not stall.
- **Limits:** it reads the permission mode at each prompt, so a shift+tab change inside a turn counts from the next prompt. It reads the command text only. It does not see a command inside a script: `rsync` inside `deploy.sh` is not caught. `wp search-replace` is held when it uses `--all-tables` or `--network`, runs through `@alias` or `--ssh`, or when the new value is a URL that is not local (`localhost`, `.test`, `.local`, `.ddev.site` are local). It does not know which database it changes: a replace typed on the live server with a local new value is not held. A remote `rsync` is held but not measured. If the terminal is too narrow for the pane (below about 144 columns), a short form shows in the band above the prompt, with the same keys. If nobody answers in 10 minutes, the command is refused.

### Status band (`statusBand`)

- **What you see:** one line above the prompt, empty at rest. `● REC` with **stop rec**. `context 52%` with **compact**. `3 edits since the last check` with **verify**. `checked, ready to push` with **push**. `2 calls denied this turn` when a tool call of the main loop was denied (a subagent call does not count). Keys 1 to 3 press the buttons.
- **When:** a check is `bun test`, `bun run typecheck|lint`, `npm test`, `npm run lint|typecheck`, `composer test|lint`, `vendor/bin/phpunit` or `phpcs`. A check that runs in the background does not count. **verify** and **push** only fill the prompt box. You press Enter.
- **Turn off:** `"statusBand": false`.
- **Limits:** the band keeps the rows of other mods and adds its own row below them. While Blast Radius holds a command, the band shows no buttons. In a short pane (about 13 rows) Claude Code gives the band no room, so nothing shows.

### Collision guard (`collisionGuard`, `collisionMinutes`)

- **What you see:** "shared.ts changed 3 min ago, not by this session. Edit it anyway?"
- **When:** before Claude edits a file that changed in the last 10 minutes (`collisionMinutes`), and the change did not come from this session. In `bypassPermissions` mode it does not ask: it writes a log line and the edit runs.
- **Turn off:** `"collisionGuard": false`.
- **Limits:** it reads the file time only, so it cannot prove who changed the file. Edits that Claude makes with shell commands are not checked.

### Recording mode (`recording`)

- **What you see:** `/rec` hides emails, keys, IBANs and amounts on screen. `/rec off` shows them again.
- **When:** while you share your screen or record a video.
- **Turn off:** `"recording": false`.
- **Limits:** screen only, by regex. Toasts, the status line, command output and dialogs are not masked.

### Completion check (`completionCheck`)

- **What you see:** nothing in `shadow` mode (the default). It writes a line to `~/.claude/logs/completion-check.jsonl`. In `block` mode, Claude must go on once when its last message says "out of scope", "pre-existing issue" or a similar excuse.
- **When:** when Claude stops.
- **Turn off:** `"completionCheck": "off"`.
- **Limits:** six fixed phrases. A different excuse passes.

### Plan mode xhigh (`planXhigh`)

- **What you see:** nothing. In plan mode, each main request goes out at `xhigh` effort.
- **When:** in plan mode, until you leave it.
- **Turn off:** `"planXhigh": false`, or type `/effort` once in the session.
- **Limits:** subagents keep their own effort.

### Prompt Bouncer (`promptBouncer`, `bouncerDocs`, `bouncerMaxChars`)

- **What you see:** in `warn` mode (the default), your prompt goes in at once. Some seconds later a toast shows "Glossary: <the prompt with the project term>". In `block` mode, the prompt is not sent. The reason and the suggestion show, and `/force <prompt>` sends it anyway.
- **When:** on each prompt that you type, in a repo that has a `GLOSSARY.md`. A Haiku call compares the prompt with `bouncerDocs` (default `GLOSSARY.md,CLAUDE.md`, at most `bouncerMaxChars` characters) and with the last answer of Claude, so a short reply such as "sì" or "1" passes. Slash commands pass.
- **Turn off:** `"promptBouncer": "off"`.
- **Limits:** no `GLOSSARY.md`, no check. One Haiku call per prompt. If Haiku fails or answers late (8 s in `block` mode), the prompt passes.

### Diagram Pane (`diagramPane`, `diagramEveryTurns`)

- **What you see:** a side pane with two parts. The mermaid flowcharts and box diagrams that Claude writes, drawn as boxes and arrows, the newest 5 first. A map of the work: the files and the steps, with ▶ on the current step.
- **When:** after each turn for the diagrams. Every `diagramEveryTurns` turns (default 3) a Haiku call asks if the work changed shape. Only on yes, a fork of the session draws a new map. `/diagram` checks now, `/diagram force` draws now.
- **Turn on:** `"diagramPane": true`. It is off by default, because the map costs a Haiku call every few turns and a fork.
- **Limits:** the pane shows when the terminal is about 144 columns or wider, or after `/diagram`. Only mermaid flowcharts are drawn. Other mermaid charts show as text.

### PHP language server

- **What you see:** Claude's LSP tool and its PHP diagnostics know the WordPress, WP-CLI, ACF PRO and WooCommerce functions and classes. Without the stubs, intelephense reports each `add_action`, `get_field` or `WP_CLI::` call as unknown.
- **When:** on each `.php` file. The plugin starts `intelephense` with the default PHP stubs plus `wordpress`, and adds the stub files in `php-stubs/` (php-stubs/wp-cli-stubs v2.12.0, woocommerce-stubs v11.2.0, acf-pro-stubs v6.8.2).
- **Setup:** install the server once with `npm install -g intelephense`. Turn off the official PHP plugin, so two PHP servers do not run: `claude plugin disable php-lsp@claude-plugins-official`.
- **Limits:** no on/off switch: the server starts only when Claude opens a `.php` file. Indexing the stubs takes some seconds, and LSP calls before it ends find no symbols. A newer plugin or WordPress version needs new stub files.

## Develop

```
bun test                  # pure tests in tests/*.spec.ts
claude plugin test .      # hook tests in hooks/register.test.ts
claude plugin validate .
```

`.claude-plugin/types/` holds the engine types. Claude Code writes the folder when it loads the plugin. Git ignores it.

## License

Apache-2.0, see `LICENSE`. Blast Radius is a modified copy of the Anthropic sample. Secret Box, Prompt Bouncer and Diagram Pane are modified copies of ray-amjad/claude-code-mods (MIT). The files in `php-stubs/` are unmodified copies from github.com/php-stubs (MIT). See `NOTICE`.
