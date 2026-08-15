# Harness Sync behavior

## State and recovery

- Canonical skills: `~/.agents/skills`.
- Backups: `${XDG_STATE_HOME:-~/.local/state}/harness-sync/backups/<timestamp>`; directory mode `0700`, files `0600`.
- `npx skills` locks remain evidence, not desired state.
- Back up every affected path before mutation. Restore automatically when apply fails.

## Harnesses

Detect Codex, Claude Code, Pi, Grok, OpenCode, Gemini, Hermes, and Goose. Mutate only installed harnesses. A config directory without its executable is audit-only. OMP is outside scope.

Prefer native MCP CLIs. Write native config directly only for formats implemented by the CLI. Unknown versions and schemas remain audit-only.

## Instruction files

In projects, `AGENTS.md` is canonical and `CLAUDE.md` is a relative symlink to it. Apply the same rule in the user home when `~/AGENTS.md` exists. Preserve a real `CLAUDE.md` until the user explicitly confirms replacement; back it up before creating the link.

## Sources

Accept local paths, GitHub/GitLab repositories and tree URLs, arbitrary git URLs supported by `npx skills`, direct skill/archive URLs, `skills.sh/<owner>/<repo>/<skill>`, and allowlisted `npx skills add ...` commands. Local sources copy by default; link only when explicitly requested.

Record original source, resolved name, scope, timestamp, and bindings. Same name with different source or content is a conflict; ask before replacing or aliasing.

## MCP

Default source and scope are `auto`. In a project prefer `.mcp.json`, then `.opencode/opencode.json`; outside a project prefer a supported global JSON config. Never silently change project/global scope.

Preserve secrets. Before writing a project file containing likely secret literals, prove the file is gitignored. Otherwise block apply. Never print secret values; report keys only.

Compare normalized transport, command, arguments, URL, environment keys, header keys, and enabled state. Same server name with a different definition is a conflict requiring confirmation.

Use `mcp --target <claude|grok|gemini> --server <name>` after resolving one conflict. JSON sources can render missing entries through proven native CLIs; unsupported targets remain audit-only.
