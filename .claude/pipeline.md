project: harness-sync
deploy_mode: none
lock_name: harness-sync-main.lock
version_file: package.json
check_cmd: bun run check
test_cmd: bun test
source_root: scripts
conventions: SKILL.md references/behavior.md
docs: README.md SKILL.md references/behavior.md
