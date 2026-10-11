# Contributing

## Layout

- One folder per plugin: `plugins/<name>/`.
- One row per plugin in `.claude-plugin/marketplace.json`, with `"source": "./plugins/<name>"`.
- Each plugin folder carries its own `LICENSE` (Apache-2.0). An install copies only the plugin folder.
- Code copied from another project keeps its copyright line and license, and gets a `NOTICE` entry.

## Before a merge

In the plugin folder:

```
bun test
claude plugin test .
claude plugin validate .
```

CI runs `bun test` in each plugin folder. CI cannot run `claude plugin test`, so run it on your machine and say so in the pull request.

## Do not publish

This repo is public. Do not commit:

- secrets, tokens or `.env` files
- personal paths, host names or tool setups (a home folder layout, a private repo, a personal vault)
- client names or client data
- the engine types in `.claude-plugin/types/` (git ignores them)

Use neutral paths in test fixtures, for example `/home/t` and `/srv/proj`.
