# Harness Sync behavior

## State and recovery

- Canonical skills: `~/.agents/skills`.
- Backups: `${XDG_STATE_HOME:-~/.local/state}/harness-sync/backups/<timestamp>`; directory mode `0700`, files `0600`.
- `npx skills` locks remain evidence, not desired state.
- Back up every affected path before mutation. Restore automatically when apply fails.

## Harnesses

Detect Codex, Claude Code, Pi, Grok, OpenCode, Gemini, Hermes, and Goose. Mutate only installed harnesses. A config directory without its executable is audit-only. OMP is outside scope.

Use native MCP CLIs for Claude, Grok, and Gemini. Render Codex TOML, OpenCode JSON, Hermes YAML, and Goose YAML while preserving unrelated config. Detect OpenCode stable and v2 shapes separately.

## Instruction files

In projects, `AGENTS.md` is canonical and `CLAUDE.md` is a relative symlink to it. Apply the same rule in the user home when `~/AGENTS.md` exists. Preserve a real `CLAUDE.md` until the user explicitly confirms replacement; back it up before creating the link.

## Sources

Accept local paths, GitHub/GitLab repositories and tree URLs, arbitrary git URLs supported by `npx skills`, direct skill/archive URLs, `skills.sh/<owner>/<repo>/<skill>`, and allowlisted `npx skills add ...` commands. Local sources copy by default; link only when explicitly requested.

## MCP

Default source and scope are `auto`. Sources may be Codex or Grok TOML; Claude, OpenCode, or Gemini JSON/JSONC; Hermes or Goose YAML; or an explicit path. Prefer project sources, then global sources. Infer an explicit path inside the Git root as project scope. Never silently change project/global scope. Hermes and Goose have no native project scope; report that limitation instead of writing globally.

Preserve secrets. Before writing a project file containing likely secret literals, prove the file is gitignored. Otherwise block apply. Never print secret values; report keys only.

Compare normalized transport, command, arguments, working directory, URL, environment, headers, and enabled state. Skip identical definitions. Same name with different semantics is a conflict requiring confirmation.

Use `mcp --target <codex|claude|grok|opencode|gemini|hermes|goose> --server <name>` to narrow a plan. Only installed targets are mutable.
