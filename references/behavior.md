# Harness Sync behavior

## State and recovery

- Canonical skills: `~/.agents/skills`.
- Backups: `${XDG_STATE_HOME:-~/.local/state}/harness-sync/backups/<timestamp>`; directory mode `0700`, files `0600`.
- `npx skills` locks remain evidence, not desired state.
- Skill provenance lives in `${XDG_STATE_HOME:-~/.local/state}/harness-sync/skills.json`. It records source, exact installed content version, current content hash, and timestamps. `init` imports trustworthy metadata from existing `npx skills` locks and marks everything else as unknown rather than guessing.
- MCP provenance lives in `${XDG_STATE_HOME:-~/.local/state}/harness-sync/mcps.json`. It records semantic hashes and config locations without secret values. Infer upstreams only for remote URLs and recognizable npm, PyPI, or container launchers; keep other sources unknown. Mark same-name semantic differences as conflicts.
- Back up every affected path before mutation. Restore automatically when apply fails.

## Harnesses

Detect Codex, Claude Code, Pi, Grok, OpenCode, Gemini, Hermes, and Goose. Default mutation targets are installed harnesses. An explicitly selected target with a direct native renderer may be updated without its CLI; CLI-backed targets still require the executable. OMP is outside scope.

Use native MCP CLIs for Claude, Grok, and Gemini. Render Codex TOML, Pi JSON, OpenCode JSON, Hermes YAML, and Goose YAML while preserving unrelated config. Detect OpenCode stable and v2 shapes separately. After every native write, keep the target config private with mode `0600`.

## Instruction files

In projects, `AGENTS.md` is canonical and `CLAUDE.md` is a relative symlink to it. Apply the same rule in the user home when `~/AGENTS.md` exists. Preserve a real `CLAUDE.md` until the user explicitly confirms replacement; back it up before creating the link.

## Sources

Accept local paths, GitHub/GitLab repositories and tree URLs, arbitrary git URLs supported by `npx skills`, direct skill/archive URLs, `skills.sh/<owner>/<repo>/<skill>`, and allowlisted `npx skills add ...` commands. Local sources copy by default; link only when explicitly requested.

Marketplace discovery is read-only. Deduplicate identical cached skills across Claude, Codex, and Grok. Native plugin remains recommended when the plugin also supplies hooks, MCP, agents, or other resources. Copy only the selected standalone skill through the existing `add` flow after confirmation.

## MCP

Default source and scope are `auto`. Sources may be Codex or Grok TOML; Claude, Pi, OpenCode, or Gemini JSON/JSONC; Hermes or Goose YAML; the repository-local `mcp.json` catalog; or an explicit path. The catalog is gitignored, retains complete definitions including environment values, and is used explicitly with `--from catalog` or `--target catalog`. Prefer project sources, then global sources. Pi uses the global `~/.pi/mcp/mcp.json` and has no project scope. Infer an explicit path inside the Git root as project scope. Never silently change project/global scope; report unsupported Pi, Hermes, or Goose project scope instead of writing globally.

Follow an exact Codex `agent-mcp-from-pi <server-name>` launcher to the matching Pi server for audit, provenance, and semantic comparison. Keep the Codex launcher's raw hash and Pi indirection beside the effective hash. Replace a proven-equal wrapper only when `--direct` is explicitly selected; the replacement uses the effective definition, never the wrapper command. Report a missing referenced Pi server with both config paths and the dependent Codex server.

Report a launcher under another harness's `~/.agents/<harness>/...` directory as harness-coupled. Prefer a reviewed direct definition before convergence; do not infer arbitrary shell behavior.

On Linux, audit absolute macOS paths under `/Users/<name>/...` and `/opt/homebrew/...` in MCP `command`, `args`, `cwd`, and environment values. Report the config file, server, field, offending path, and every wrapper-dependent harness. A `~` home reference is portable: preserve it in rendering and expand it only for local file access.

Preserve secrets. Before writing a project file containing likely secret literals, prove the file is gitignored. Otherwise block apply. Never print secret values; report keys only.

Compare normalized transport, command, arguments, working directory, URL, environment, headers, and enabled state within one scope. Skip identical definitions; different names and project/global variants are normal coexistence. A same-name semantic difference in the selected scope is a conflict. Choose a complete source or target variant, review a merge only when fields do not collide, or skip. The selected definition is applied only to the selected bindings.

Every dry run emits a JSON plan with `apply: false` and `writes: []`. It contains paths, differing field names, and environment/header keys, never their values. A non-interactive unresolved conflict exits with code 2 and performs no writes. `--apply --confirmed` remains a separate write gate after the plan and conflict choices have been reviewed.

Use `mcp --target <codex|claude|pi|grok|opencode|gemini|hermes|goose> --server <name>` to narrow a plan. Only installed targets are mutable.

Use repeated `mcp-remove --server <name> --target <harness> --scope project|global` flags to remove exact bindings. Scope is mandatory. The dry run lists every affected path, missing binding, and native renderer without secret values. Removal preserves unrelated servers and unknown fields, backs up every affected config and the provenance manifest, restores them on failure, and refreshes provenance after success.
