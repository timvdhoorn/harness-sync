#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type McpServer = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: "stdio" | "http" | "sse";
  enabled?: boolean;
};

type Harness = {
  id: string;
  executable: string;
  skillDir: string;
  mcpFiles: string[];
  npxAgent?: string;
};

type McpSource = { harness: string; path: string; scope: "project" | "global" };
type SkillIssue = { path: string; issue: string };
type MarketplaceSkill = { name: string; hash: string; status: "available" | "canonical" | "conflict"; sources: Array<{ harness: string; marketplace: string; plugin: string; path: string }> };

const home = homedir();
const stateRoot = process.env.XDG_STATE_HOME
  ? join(process.env.XDG_STATE_HOME, "harness-sync")
  : join(home, ".local", "state", "harness-sync");
const canonicalSkills = join(home, ".agents", "skills");
const cwd = process.cwd();

export const harnesses: Harness[] = [
  { id: "codex", executable: "codex", skillDir: join(home, ".codex", "skills"), mcpFiles: [join(home, ".codex", "config.toml")], npxAgent: "codex" },
  { id: "claude", executable: "claude", skillDir: join(home, ".claude", "skills"), mcpFiles: [join(cwd, ".mcp.json"), join(home, ".claude.json")], npxAgent: "claude-code" },
  { id: "pi", executable: "pi", skillDir: join(home, ".pi", "agent", "skills"), mcpFiles: [], npxAgent: "pi" },
  { id: "grok", executable: "grok", skillDir: join(home, ".grok", "skills"), mcpFiles: [join(cwd, ".grok", "config.toml"), join(home, ".grok", "config.toml")], npxAgent: "grok" },
  { id: "opencode", executable: "opencode", skillDir: join(home, ".config", "opencode", "skills"), mcpFiles: [join(cwd, ".opencode", "opencode.json"), join(home, ".config", "opencode", "opencode.json")], npxAgent: "opencode" },
  { id: "gemini", executable: "gemini", skillDir: join(home, ".gemini", "skills"), mcpFiles: [join(cwd, ".gemini", "settings.json"), join(home, ".gemini", "settings.json")], npxAgent: "gemini-cli" },
  { id: "hermes", executable: "hermes", skillDir: join(home, ".hermes", "skills"), mcpFiles: [join(home, ".hermes", "config.yaml")], npxAgent: "hermes-agent" },
  { id: "goose", executable: "goose", skillDir: join(home, ".config", "goose", "skills"), mcpFiles: [join(home, ".config", "goose", "config.yaml")], npxAgent: "goose" },
];

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function commandExists(command: string): boolean {
  const result = Bun.spawnSync([platform() === "win32" ? "where" : "which", command], { stdout: "ignore", stderr: "ignore" });
  return result.exitCode === 0;
}

function run(args: string[], options: { cwd?: string; quiet?: boolean } = {}): string {
  const result = Bun.spawnSync(args, { cwd: options.cwd ?? cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const out = result.stdout.toString();
  const error = result.stderr.toString();
  if (!options.quiet && out) process.stdout.write(out);
  if (result.exitCode !== 0) throw new Error(`${args[0]} exited ${result.exitCode}: ${(error || out).trim().split("\n").at(-1)}`);
  return out;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.harness-sync-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function writeTextAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.harness-sync-${process.pid}`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function backup(paths: string[]): string {
  const root = join(stateRoot, "backups", timestamp());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const manifest: Array<{ source: string; backup?: string; kind: "file" | "directory" | "symlink" | "missing" }> = [];
  for (const source of [...new Set(paths)]) {
    if (!existsSync(source)) {
      manifest.push({ source, kind: "missing" });
      continue;
    }
    const target = join(root, createHash("sha256").update(source).digest("hex").slice(0, 16));
    const info = lstatSync(source);
    const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file";
    cpSync(source, target, { recursive: true, dereference: false });
    manifest.push({ source, backup: target, kind });
  }
  writeJsonAtomic(join(root, "manifest.json"), manifest);
  return root;
}

function restoreBackup(root: string): void {
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) return;
  const manifest = readJson(manifestPath) as Array<{ source: string; backup?: string; kind: string }>;
  for (const item of manifest.reverse()) {
    if (existsSync(item.source)) rmSync(item.source, { recursive: true, force: true });
    if (item.kind === "missing" || !item.backup) continue;
    mkdirSync(dirname(item.source), { recursive: true });
    cpSync(item.backup, item.source, { recursive: true, dereference: false });
  }
}

function cleanOldBackups(): void {
  const root = join(stateRoot, "backups");
  if (!existsSync(root)) return;
  const entries = readdirSync(root).sort().reverse();
  for (const stale of entries.slice(10)) rmSync(join(root, stale), { recursive: true, force: true });
}

function hashTree(path: string): string {
  const hash = createHash("sha256");
  const visit = (current: string, prefix: string) => {
    for (const name of readdirSync(current).sort()) {
      const child = join(current, name);
      const item = lstatSync(child);
      hash.update(`${prefix}${name}:${item.isDirectory() ? "d" : item.isSymbolicLink() ? "l" : "f"}\0`);
      if (item.isDirectory()) visit(child, `${prefix}${name}/`);
      else if (item.isSymbolicLink()) hash.update(readlinkSync(child));
      else hash.update(readFileSync(child));
    }
  };
  visit(path, "");
  return hash.digest("hex");
}

function skillMetadataIssue(path: string, directoryName: string): string | undefined {
  const skillFile = join(path, "SKILL.md");
  if (!existsSync(skillFile)) return "missing-SKILL.md";
  const text = readFileSync(skillFile, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return "invalid-frontmatter";
  const declaredName = frontmatter.match(/^name:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  if (!declaredName) return "missing-frontmatter-name";
  if (declaredName !== directoryName) return `name-mismatch:${declaredName}`;
}

export function validSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

function detectedHarnesses(): Array<Harness & { installed: boolean }> {
  return harnesses.map((harness) => ({ ...harness, installed: commandExists(harness.executable) }));
}

export function inspectSkillDirectory(skillDir: string, canonicalDir = canonicalSkills): SkillIssue[] {
  const issues: SkillIssue[] = [];
  if (!pathExists(skillDir)) return [{ path: skillDir, issue: "missing-directory" }];
  const rootInfo = lstatSync(skillDir);
  if (rootInfo.isSymbolicLink()) {
    try {
      if (realpathSync(skillDir) !== realpathSync(canonicalDir)) issues.push({ path: skillDir, issue: "wrong-directory-link" });
    } catch { issues.push({ path: skillDir, issue: "broken-directory-link" }); }
    return issues;
  }
  for (const name of readdirSync(skillDir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(skillDir, name);
    const expected = join(canonicalDir, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      try {
        const actualTarget = realpathSync(path);
        if (!pathExists(expected) || actualTarget !== realpathSync(expected)) issues.push({ path, issue: "wrong-skill-link" });
      } catch { issues.push({ path, issue: "broken-skill-link" }); }
    } else if (info.isDirectory()) {
      const metadataIssue = skillMetadataIssue(path, name);
      if (metadataIssue) issues.push({ path, issue: metadataIssue });
      else if (!pathExists(expected)) issues.push({ path, issue: "untracked-copy" });
      else {
        const expectedPath = realpathSync(expected);
        const expectedInfo = statSync(expectedPath);
        if (!expectedInfo.isDirectory() || hashTree(path) !== hashTree(expectedPath)) issues.push({ path, issue: "copy-drift" });
        else issues.push({ path, issue: "copy" });
      }
    }
  }
  return issues;
}

export function discoverMarketplaceSkills(
  roots: Array<{ harness: string; path: string }> = [
    { harness: "claude", path: join(home, ".claude", "plugins", "cache") },
    { harness: "codex", path: join(home, ".codex", "plugins", "cache") },
    { harness: "grok", path: join(home, ".grok", "plugins", "marketplaces") },
  ],
  canonicalDir = canonicalSkills,
): MarketplaceSkill[] {
  const grouped = new Map<string, MarketplaceSkill>();
  const visit = (root: { harness: string; path: string }, path: string, depth: number) => {
    if (depth > 8) return;
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      if (!lstatSync(child).isDirectory()) continue;
      const skillFile = join(child, "SKILL.md");
      if (existsSync(skillFile)) {
        const hash = createHash("sha256").update(readFileSync(skillFile)).digest("hex");
        const key = `${name}:${hash}`;
        const canonicalFile = join(canonicalDir, name, "SKILL.md");
        const canonicalHash = existsSync(canonicalFile) ? createHash("sha256").update(readFileSync(canonicalFile)).digest("hex") : "";
        const parts = relative(root.path, child).split("/");
        const item = grouped.get(key) ?? { name, hash, status: canonicalHash === hash ? "canonical" : canonicalHash ? "conflict" : "available", sources: [] };
        item.sources.push({ harness: root.harness, marketplace: parts[0] ?? "unknown", plugin: parts[1] ?? name, path: child });
        grouped.set(key, item);
      } else visit(root, child, depth + 1);
    }
  };
  for (const root of roots) if (existsSync(root.path)) visit(root, root.path, 0);
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeMcpMap(raw: Record<string, any>): Record<string, McpServer> {
  return Object.fromEntries(Object.entries(raw).flatMap(([name, server]) => {
    if (!server || typeof server !== "object") return [];
    const commandArray = Array.isArray(server.command) ? server.command : undefined;
    const command = server.command ?? server.cmd;
    const url = server.url ?? server.uri;
    if (!command && !url) return [];
    const type = server.type === "remote" ? "http" : server.type === "local" ? "stdio" : server.type;
    return [[name, {
      ...(type ? { type } : {}),
      ...(command ? { command: commandArray ? commandArray[0] : command } : {}),
      ...(commandArray || server.args ? { args: commandArray ? commandArray.slice(1) : server.args } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.env || server.environment || server.envs ? { env: server.env ?? server.environment ?? server.envs } : {}),
      ...(url ? { url } : {}),
      ...(server.headers || server.http_headers ? { headers: server.headers ?? server.http_headers } : {}),
      ...(server.enabled !== undefined || server.disabled !== undefined || server.type === "local" || server.type === "remote" ? { enabled: server.disabled !== true && server.enabled !== false } : {}),
    }]];
  }));
}

export function normalizeMcpJson(path: string): Record<string, McpServer> {
  const json = path.endsWith(".jsonc") ? Bun.JSONC.parse(readFileSync(path, "utf8")) as any : readJson(path);
  if (json.mcpServers && typeof json.mcpServers === "object") return normalizeMcpMap(json.mcpServers);
  if (json.mcp?.servers && typeof json.mcp.servers === "object") return normalizeMcpMap(json.mcp.servers);
  if (json.mcp && typeof json.mcp === "object") return normalizeMcpMap(json.mcp);
  return {};
}

export function normalizeMcpFile(path: string): Record<string, McpServer> {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json") || path.endsWith(".jsonc")) return normalizeMcpJson(path);
  const parsed = path.endsWith(".toml") ? Bun.TOML.parse(text) : Bun.YAML.parse(text) as any;
  const raw = parsed.mcp_servers ?? parsed.mcpServers ?? parsed.mcp ?? parsed.extensions ?? {};
  return normalizeMcpMap(raw);
}

function mcpInventory(path: string): string[] {
  if (!existsSync(path)) return [];
  try { return Object.keys(normalizeMcpFile(path)); } catch { return []; }
}

type InstructionsStatus = {
  root: string;
  agents: string;
  claude: string;
  status: "missing-agents" | "missing-claude" | "correct-link" | "wrong-link" | "conflict";
};

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function projectRoot(): string {
  if (!commandExists("git")) return cwd;
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : cwd;
}

export function inspectInstructions(root: string): InstructionsStatus {
  const agents = join(root, "AGENTS.md");
  const claude = join(root, "CLAUDE.md");
  if (!pathExists(agents)) return { root, agents, claude, status: "missing-agents" };
  if (!pathExists(claude)) return { root, agents, claude, status: "missing-claude" };
  if (!lstatSync(claude).isSymbolicLink()) return { root, agents, claude, status: "conflict" };
  try {
    return { root, agents, claude, status: realpathSync(claude) === realpathSync(agents) ? "correct-link" : "wrong-link" };
  } catch {
    return { root, agents, claude, status: "wrong-link" };
  }
}

function instructionTargets(scope: string): InstructionsStatus[] {
  const roots = scope === "project" ? [projectRoot()] : scope === "user" ? [home] : [projectRoot(), home];
  return [...new Set(roots)].map(inspectInstructions);
}

function syncInstructions(args: string[]): void {
  const apply = applyRequired(args);
  const scopeIndex = args.indexOf("--scope");
  const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : "all";
  if (!["project", "user", "all"].includes(scope)) fail("--scope must be project, user, or all");
  const targets = instructionTargets(scope);
  for (const item of targets) console.log(`${item.root}: ${item.status}`);
  const changes = targets.filter((item) => ["missing-claude", "wrong-link", "conflict"].includes(item.status));
  const conflicts = changes.filter((item) => item.status === "conflict");
  console.log(`Plan: link ${changes.length} CLAUDE.md path(s) to AGENTS.md`);
  if (!apply) return;
  if (conflicts.length && !args.includes("--replace")) fail(`existing CLAUDE.md requires explicit --replace: ${conflicts.map((item) => item.claude).join(", ")}`);
  const backupRoot = backup(changes.map((item) => item.claude));
  try {
    for (const item of changes) {
      if (pathExists(item.claude)) rmSync(item.claude, { recursive: true, force: true });
      symlinkSync("AGENTS.md", item.claude);
    }
    cleanOldBackups();
    console.log(`Applied ${changes.length} instruction link(s). Backup: ${backupRoot}`);
  } catch (error) {
    restoreBackup(backupRoot);
    throw new Error(`instruction sync failed; rolled back from ${backupRoot}: ${(error as Error).message}`);
  }
}

function audit(asJson: boolean): void {
  const canonicalIssues = pathExists(canonicalSkills)
    ? readdirSync(canonicalSkills).sort().flatMap((name) => {
      const path = join(canonicalSkills, name);
      if (name.startsWith(".") || !lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) return [];
      const issue = skillMetadataIssue(path, name);
      return issue ? [{ path, issue }] : [];
    })
    : [{ path: canonicalSkills, issue: "missing-directory" }];
  const skills = detectedHarnesses().map(({ id, installed, skillDir }) => ({ id, installed, skillDir, issues: inspectSkillDirectory(skillDir) }));
  const marketplaceSkills = discoverMarketplaceSkills();
  const mcp = harnesses.flatMap((harness) => harness.mcpFiles.filter(existsSync).map((path) => ({ harness: harness.id, path, servers: mcpInventory(path) })));
  const instructions = instructionTargets("all");
  const result = { canonicalSkills, canonicalExists: existsSync(canonicalSkills), canonicalIssues, skills, marketplaceSkills, mcp, instructions };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Canonical skills: ${canonicalSkills} (${result.canonicalExists ? "ok" : "missing"})`);
    if (canonicalIssues.length) console.log(`canonical issues: ${canonicalIssues.length}`);
    for (const item of skills) console.log(`${item.id}: ${item.installed ? "installed" : "config-only"}; skill-issues=${item.issues.length}`);
    const candidates = marketplaceSkills.filter((item) => item.status !== "canonical");
    console.log(`marketplace skills: ${marketplaceSkills.length}; choices=${candidates.length}`);
    for (const item of mcp) console.log(`${item.harness}: ${item.servers.length} MCP server(s) in ${item.path}`);
    for (const item of instructions) console.log(`instructions ${item.root}: ${item.status}`);
  }
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "", quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) tokens.push(current), current = ""; }
    else current += char;
  }
  if (quote) throw new Error("unterminated quote in npx command");
  if (current) tokens.push(current);
  return tokens;
}

export function normalizeAddInput(input: string[]): string[] {
  if (!input.length) throw new Error("add requires a source or npx skills add command");
  let args = input.length === 1 && input[0].includes(" ") ? tokenize(input[0]) : [...input];
  if (args[0] === "npx") {
    const addIndex = args.indexOf("add");
    const skillsIndex = args.findIndex((item) => item === "skills" || item.endsWith("/skills"));
    if (skillsIndex < 0 || addIndex !== skillsIndex + 1) throw new Error("only npx skills add commands are accepted");
    args = args.slice(addIndex + 1);
  }
  const source = args[0];
  const skillsMatch = source.match(/^https?:\/\/(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)\/([^/?#]+)\/?$/);
  if (skillsMatch) return [`${skillsMatch[1]}/${skillsMatch[2]}`, "--skill", skillsMatch[3], ...args.slice(1)];
  if (source.startsWith("-") || source.includes("\0")) throw new Error("invalid source");
  return args;
}

function applyRequired(args: string[]): boolean {
  const apply = args.includes("--apply");
  if (apply && !args.includes("--confirmed")) fail("--apply requires --confirmed after explicit user confirmation");
  return apply;
}

function addSkill(args: string[]): void {
  const apply = applyRequired(args);
  const sourceArgs = normalizeAddInput(args.filter((arg) => arg !== "--apply" && arg !== "--confirmed"));
  const agents = detectedHarnesses().filter((item) => item.installed && item.npxAgent).map((item) => item.npxAgent!);
  const command = ["npx", "--yes", "skills", "add", ...sourceArgs, "-g", "-y", "--agent", ...agents];
  console.log(`Plan: ${command.join(" ")}`);
  if (!apply) return;
  const backupRoot = backup([canonicalSkills, ...harnesses.map((item) => item.skillDir)]);
  try {
    run(command);
    cleanOldBackups();
    console.log(`Applied. Backup: ${backupRoot}`);
  } catch (error) {
    restoreBackup(backupRoot);
    throw new Error(`add failed; rolled back from ${backupRoot}: ${(error as Error).message}`);
  }
}

function npxLockOwns(name: string): boolean {
  for (const path of [join(home, ".agents", ".skill-lock.json"), join(cwd, "skills-lock.json")]) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      if (text.includes(`\"${name}\"`)) return true;
    } catch { /* audit reports malformed files separately */ }
  }
  return false;
}

export function removalTargets(name: string, skillDirs = [canonicalSkills, ...harnesses.map((item) => item.skillDir)]): string[] {
  return [...new Set(skillDirs.map((directory) => join(directory, name)))].filter(pathExists);
}

function removeSkill(name: string, args: string[]): void {
  const apply = applyRequired(args);
  if (!validSkillName(name)) fail("invalid skill name");
  const targets = removalTargets(name);
  if (!targets.length) fail(`skill not found: ${name}`);
  console.log(`Plan: remove ${name} from ${targets.length} path(s):\n${targets.join("\n")}`);
  if (!apply) return;
  const backupRoot = backup([...targets, join(home, ".agents", ".skill-lock.json"), join(cwd, "skills-lock.json")]);
  try {
    if (npxLockOwns(name)) run(["npx", "--yes", "skills", "remove", name, "-g", "-y"]);
    for (const target of targets) if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cleanOldBackups();
    console.log(`Removed ${name}. Backup: ${backupRoot}`);
  } catch (error) {
    restoreBackup(backupRoot);
    throw new Error(`remove failed; rolled back from ${backupRoot}: ${(error as Error).message}`);
  }
}

function updateSkills(names: string[], args: string[]): void {
  const apply = applyRequired(args);
  const cleanNames = names.filter((name) => !name.startsWith("--"));
  for (const name of cleanNames) if (!validSkillName(name)) fail(`invalid skill name: ${name}`);
  const command = ["npx", "--yes", "skills", "update", ...cleanNames, "-g", "-y"];
  console.log(`Plan: ${command.join(" ")}; upstream deletions remain pending`);
  if (!apply) return;
  const backupRoot = backup([join(home, ".agents", ".skill-lock.json"), canonicalSkills]);
  try { run(command); cleanOldBackups(); console.log(`Applied. Backup: ${backupRoot}`); }
  catch (error) { restoreBackup(backupRoot); throw new Error(`update failed; rolled back from ${backupRoot}: ${(error as Error).message}`); }
}

function hasSecretLiterals(servers: Record<string, McpServer>): boolean {
  const values = Object.values(servers).flatMap((server) => [
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
  ]);
  return values.some((value) => value.length > 0 && !/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value));
}

function gitIgnored(path: string): boolean {
  if (!commandExists("git")) return false;
  const result = Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd, stdout: "ignore", stderr: "ignore" });
  return result.exitCode === 0;
}

function mcpSources(): McpSource[] {
  const root = projectRoot();
  return [
    { harness: "claude", path: join(root, ".mcp.json"), scope: "project" },
    { harness: "codex", path: join(root, ".codex", "config.toml"), scope: "project" },
    { harness: "grok", path: join(root, ".grok", "config.toml"), scope: "project" },
    { harness: "opencode", path: join(root, "opencode.json"), scope: "project" },
    { harness: "opencode", path: join(root, ".opencode", "opencode.json"), scope: "project" },
    { harness: "gemini", path: join(root, ".gemini", "settings.json"), scope: "project" },
    { harness: "claude", path: join(home, ".claude.json"), scope: "global" },
    { harness: "codex", path: join(home, ".codex", "config.toml"), scope: "global" },
    { harness: "grok", path: join(home, ".grok", "config.toml"), scope: "global" },
    { harness: "opencode", path: join(home, ".config", "opencode", "opencode.json"), scope: "global" },
    { harness: "gemini", path: join(home, ".gemini", "settings.json"), scope: "global" },
    { harness: "hermes", path: join(home, ".hermes", "config.yaml"), scope: "global" },
    { harness: "goose", path: join(home, ".config", "goose", "config.yaml"), scope: "global" },
  ];
}

function mcpTargetPath(harness: string, scope: "project" | "global"): string | undefined {
  const root = projectRoot();
  const paths: Record<string, { project?: string; global: string }> = {
    codex: { project: join(root, ".codex", "config.toml"), global: join(home, ".codex", "config.toml") },
    claude: { project: join(root, ".mcp.json"), global: join(home, ".claude.json") },
    grok: { project: join(root, ".grok", "config.toml"), global: join(home, ".grok", "config.toml") },
    opencode: { project: join(root, "opencode.json"), global: join(home, ".config", "opencode", "opencode.json") },
    gemini: { project: join(root, ".gemini", "settings.json"), global: join(home, ".gemini", "settings.json") },
    hermes: { global: join(home, ".hermes", "config.yaml") },
    goose: { global: join(home, ".config", "goose", "config.yaml") },
  };
  return paths[harness]?.[scope];
}

function renderCodex(path: string, servers: Record<string, McpServer>): void {
  let text = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
  const line = (key: string, value: unknown) => `${key} = ${JSON.stringify(value)}`;
  for (const [name, server] of Object.entries(servers)) {
    const section = JSON.stringify(name);
    const values = [
      server.url ? line("url", server.url) : line("command", server.command),
      ...(server.args?.length ? [line("args", server.args)] : []),
      ...(server.cwd ? [line("cwd", server.cwd)] : []),
      line("enabled", server.enabled !== false),
    ];
    text += `${text ? "\n\n" : ""}[mcp_servers.${section}]\n${values.join("\n")}`;
    for (const [field, entries] of [["env", server.env], ["http_headers", server.headers]] as const) {
      if (!entries || !Object.keys(entries).length) continue;
      text += `\n\n[mcp_servers.${section}.${field}]\n${Object.entries(entries).map(([key, value]) => line(JSON.stringify(key), value)).join("\n")}`;
    }
  }
  writeTextAtomic(path, `${text}\n`);
}

function renderOpenCode(path: string, servers: Record<string, McpServer>): void {
  const json: any = existsSync(path) ? (path.endsWith(".jsonc") ? Bun.JSONC.parse(readFileSync(path, "utf8")) : readJson(path)) : { $schema: "https://opencode.ai/config.json" };
  const v2 = Boolean(json.mcp?.servers);
  const target = v2 ? (json.mcp.servers ??= {}) : (json.mcp ??= {});
  for (const [name, server] of Object.entries(servers)) {
    target[name] = server.url
      ? { type: "remote", url: server.url, ...(server.headers ? { headers: server.headers } : {}), ...(v2 ? { disabled: server.enabled === false } : { enabled: server.enabled !== false }) }
      : { type: "local", command: [server.command, ...(server.args ?? [])], ...(server.cwd ? { cwd: server.cwd } : {}), ...(server.env ? { environment: server.env } : {}), ...(v2 ? { disabled: server.enabled === false } : { enabled: server.enabled !== false }) };
  }
  writeJsonAtomic(path, json);
}

function renderYamlTarget(path: string, harness: "hermes" | "goose", servers: Record<string, McpServer>): void {
  const yaml: any = existsSync(path) ? Bun.YAML.parse(readFileSync(path, "utf8")) : {};
  const target = harness === "hermes" ? (yaml.mcp_servers ??= {}) : (yaml.extensions ??= {});
  for (const [name, server] of Object.entries(servers)) {
    target[name] = harness === "hermes"
      ? { ...(server.url ? { url: server.url } : { command: server.command, args: server.args ?? [] }), ...(server.env ? { env: server.env } : {}), ...(server.headers ? { headers: server.headers } : {}), enabled: server.enabled !== false }
      : { name, type: server.url ? "streamable_http" : "stdio", enabled: server.enabled !== false, ...(server.url ? { uri: server.url, ...(server.headers ? { headers: server.headers } : {}) } : { cmd: server.command, args: server.args ?? [], ...(server.env ? { envs: server.env } : {}) }) };
  }
  writeTextAtomic(path, Bun.YAML.stringify(yaml));
}

export function renderDirectTarget(harness: string, path: string, servers: Record<string, McpServer>): void {
  if (harness === "codex") return renderCodex(path, servers);
  if (harness === "opencode") return renderOpenCode(path, servers);
  if (harness === "hermes" || harness === "goose") return renderYamlTarget(path, harness, servers);
  fail(`no direct MCP renderer for ${harness}`);
}

function sourceForMcp(from: string, scope: string): McpSource {
  const directPath = isAbsolute(from) || from.startsWith(".") ? resolve(cwd, from) : "";
  if (directPath) {
    if (!existsSync(directPath)) fail(`MCP source not found: ${directPath}`);
    return { harness: "file", path: directPath, scope: scope === "auto" ? inferMcpScope(directPath, projectRoot()) : scope as "project" | "global" };
  }
  const choices = mcpSources().filter((source) =>
    existsSync(source.path)
    && Object.keys(normalizeMcpFile(source.path)).length > 0
    && (scope === "auto" || source.scope === scope)
    && (from === "auto" || source.harness === from)
  );
  if (!choices.length) fail(`no supported ${scope} MCP source found for ${from}`);
  return choices[0];
}

export function inferMcpScope(path: string, root: string): "project" | "global" {
  const position = relative(root, path);
  return path === root || (!position.startsWith("..") && !isAbsolute(position)) ? "project" : "global";
}

function semanticMcp(server: McpServer): unknown {
  const sorted = (value: Record<string, string> | undefined) => Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b)));
  return {
    type: server.url ? (server.type === "sse" ? "sse" : "http") : "stdio",
    command: server.command ?? "",
    args: server.args ?? [],
    cwd: server.cwd ?? "",
    env: sorted(server.env),
    url: server.url ?? "",
    headers,
    enabled: server.enabled !== false,
  };
}

export function sameMcpServer(left: McpServer, right: McpServer): boolean {
  return JSON.stringify(semanticMcp(left)) === JSON.stringify(semanticMcp(right));
}

function targetMcpServers(harness: string, scope: "project" | "global"): Record<string, McpServer> {
  const path = mcpTargetPath(harness, scope);
  return path && existsSync(path) ? normalizeMcpFile(path) : {};
}

function mcpSync(args: string[]): void {
  const apply = applyRequired(args);
  const valueAfter = (flag: string, fallback: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
  const from = valueAfter("--from", "auto");
  const scope = valueAfter("--scope", existsSync(join(cwd, ".git")) ? "project" : "auto");
  const source = sourceForMcp(from, scope);
  const effectiveScope = scope === "auto" ? source.scope : scope;
  const requestedServer = valueAfter("--server", "");
  const allServers = normalizeMcpFile(source.path);
  const servers = requestedServer ? Object.fromEntries(Object.entries(allServers).filter(([name]) => name === requestedServer)) : allServers;
  if (requestedServer && !Object.keys(servers).length) fail(`MCP server not found in source: ${requestedServer}`);
  const requestedTarget = valueAfter("--target", "");
  const supportedTargets = ["codex", "claude", "grok", "opencode", "gemini", "hermes", "goose"];
  const installed = detectedHarnesses().filter((item) => item.installed && supportedTargets.includes(item.id) && (!requestedTarget || item.id === requestedTarget));
  if (requestedTarget && !installed.length) fail(`MCP target not installed or unsupported: ${requestedTarget}`);
  const conflicts: string[] = [], identical: string[] = [], missing: Array<{ harness: string; name: string }> = [];
  const unsupported = installed.filter((target) => !mcpTargetPath(target.id, effectiveScope)).map((target) => `${target.id}:${effectiveScope}`);
  for (const target of installed) {
    if (!mcpTargetPath(target.id, effectiveScope)) continue;
    const existing = targetMcpServers(target.id, effectiveScope);
    for (const [name, server] of Object.entries(servers)) {
      if (!existing[name]) missing.push({ harness: target.id, name });
      else if (sameMcpServer(server, existing[name])) identical.push(`${target.id}:${name}`);
      else conflicts.push(`${target.id}:${name}`);
    }
  }
  console.log(`Source: ${source.harness}:${source.path} (${Object.keys(servers).length} servers); scope=${effectiveScope}`);
  console.log(`Missing: ${missing.map((item) => `${item.harness}:${item.name}`).join(", ") || "none"}`);
  console.log(`Identical: ${identical.join(", ") || "none"}`);
  console.log(`Conflicts: ${conflicts.join(", ") || "none"}`);
  console.log(`Unsupported scope: ${unsupported.join(", ") || "none"}`);
  if (!apply) return;
  if (conflicts.length) fail("existing server names require separate conflict confirmation; resolve or narrow source first");
  const targetPaths = installed.map((item) => mcpTargetPath(item.id, effectiveScope)).filter((path): path is string => Boolean(path));
  if (effectiveScope === "project" && hasSecretLiterals(servers)) {
    const unsafe = targetPaths.filter((path) => !gitIgnored(path));
    if (unsafe.length) fail(`secret-bearing project configs must be gitignored: ${unsafe.join(", ")}`);
  }
  const backupRoot = backup(targetPaths);
  try {
    for (const harness of ["codex", "opencode", "hermes", "goose"]) {
      const path = mcpTargetPath(harness, effectiveScope);
      const selected = Object.fromEntries(missing.filter((item) => item.harness === harness).map((item) => [item.name, servers[item.name]]));
      if (path && Object.keys(selected).length) renderDirectTarget(harness, path, selected);
    }
    for (const item of missing) {
      if (["codex", "opencode", "hermes", "goose"].includes(item.harness)) continue;
      const server = servers[item.name];
      const transport = server.url ? (server.type === "sse" ? "sse" : "http") : "stdio";
      const envArgs = Object.entries(server.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      const headerArgs = Object.entries(server.headers ?? {}).flatMap(([key, value]) => ["--header", `${key}: ${value}`]);
      if (item.harness === "claude") {
        const targetScope = effectiveScope === "global" ? "user" : "project";
        run(["claude", "mcp", "add", "--scope", targetScope, "--transport", transport, ...envArgs, ...headerArgs, item.name, ...(server.url ? [server.url] : ["--", server.command!, ...(server.args ?? [])])]);
      } else if (item.harness === "grok") {
        const targetScope = effectiveScope === "project" ? "project" : "user";
        run(["grok", "mcp", "add", "--scope", targetScope, "--transport", transport, ...envArgs, ...headerArgs, item.name, ...(server.url ? [server.url] : ["--", server.command!, ...(server.args ?? [])])]);
      } else if (item.harness === "gemini") {
        const targetScope = effectiveScope === "global" ? "user" : "project";
        run(["gemini", "mcp", "add", "--scope", targetScope, "--transport", transport, ...envArgs, ...headerArgs, item.name, ...(server.url ? [server.url] : [server.command!, ...(server.args ?? [])])]);
      }
    }
    cleanOldBackups();
    console.log(`Applied ${missing.length} MCP binding(s). Backup: ${backupRoot}`);
  } catch (error) {
    restoreBackup(backupRoot);
    throw new Error(`MCP sync failed; rolled back from ${backupRoot}: ${(error as Error).message}`);
  }
}

function usage(): void {
  console.log(`harness-sync [audit|instructions|add|remove|update|mcp]\n\nRecommended: audit\nRun a command without --apply for a plan. Writes require --apply --confirmed.`);
}

export function main(argv = process.argv.slice(2)): void {
  const [command, ...args] = argv;
  try {
    if (!command) return usage();
    if (command === "audit") return audit(args.includes("--json"));
    if (command === "instructions") return syncInstructions(args);
    if (command === "add") return addSkill(args);
    if (command === "remove") return removeSkill(args[0] ?? "", args.slice(1));
    if (command === "update") return updateSkills(args, args);
    if (command === "mcp") return mcpSync(args);
    usage();
    fail(`unknown command: ${command}`);
  } catch (error) {
    fail((error as Error).message);
  }
}

if (import.meta.main) main();
