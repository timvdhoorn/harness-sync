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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type McpServer = {
  command?: string;
  args?: string[];
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

export function validSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

function detectedHarnesses(): Array<Harness & { installed: boolean; skillStatus: string }> {
  return harnesses.map((harness) => {
    const installed = commandExists(harness.executable);
    let skillStatus = "missing";
    if (existsSync(harness.skillDir)) {
      const info = lstatSync(harness.skillDir);
      if (info.isSymbolicLink()) {
        try {
          skillStatus = realpathSync(harness.skillDir) === realpathSync(canonicalSkills) ? "canonical-link" : `wrong-link:${readlinkSync(harness.skillDir)}`;
        } catch {
          skillStatus = "broken-link";
        }
      } else if (info.isDirectory()) {
        let broken = 0;
        for (const entry of readdirSync(harness.skillDir)) {
          const path = join(harness.skillDir, entry);
          if (lstatSync(path).isSymbolicLink()) {
            try { realpathSync(path); } catch { broken += 1; }
          }
        }
        skillStatus = broken ? `directory:${broken}-broken-links` : "directory";
      }
    }
    return { ...harness, installed, skillStatus };
  });
}

function parseTomlNames(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/^\[mcp_servers\.([^\].]+)\]$/gm)].map((match) => match[1]);
}

export function normalizeMcpJson(path: string): Record<string, McpServer> {
  const json = readJson(path);
  if (json.mcpServers && typeof json.mcpServers === "object") return json.mcpServers;
  if (json.mcp && typeof json.mcp === "object") {
    return Object.fromEntries(Object.entries(json.mcp).map(([name, raw]: [string, any]) => {
      if (raw.type === "local") {
        const command = Array.isArray(raw.command) ? raw.command : [];
        return [name, { type: "stdio", command: command[0], args: command.slice(1), env: raw.environment, enabled: raw.enabled !== false }];
      }
      return [name, { type: raw.type === "remote" ? "http" : raw.type, url: raw.url, headers: raw.headers, enabled: raw.enabled !== false }];
    }));
  }
  return {};
}

function mcpInventory(path: string): string[] {
  if (!existsSync(path)) return [];
  if (path.endsWith(".toml")) return parseTomlNames(path);
  if (path.endsWith(".json")) return Object.keys(normalizeMcpJson(path));
  return [];
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
  const skills = detectedHarnesses().map(({ id, installed, skillDir, skillStatus }) => ({ id, installed, skillDir, skillStatus }));
  const mcp = harnesses.flatMap((harness) => harness.mcpFiles.filter(existsSync).map((path) => ({ harness: harness.id, path, servers: mcpInventory(path) })));
  const instructions = instructionTargets("all");
  const result = { canonicalSkills, canonicalExists: existsSync(canonicalSkills), skills, mcp, instructions };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Canonical skills: ${canonicalSkills} (${result.canonicalExists ? "ok" : "missing"})`);
    for (const item of skills) console.log(`${item.id}: ${item.installed ? "installed" : "config-only"}; skills=${item.skillStatus}`);
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

function sourceForMcp(from: string, scope: string): string {
  const projectSources = [join(cwd, ".mcp.json"), join(cwd, ".opencode", "opencode.json")];
  const globalSources = [join(home, ".config", "opencode", "opencode.json"), join(home, ".gemini", "settings.json")];
  const choices = scope === "project" ? projectSources : scope === "global" ? globalSources : [...projectSources, ...globalSources];
  const filtered = choices.filter((path) => existsSync(path) && (from === "auto" || path.includes(from === "claude" ? ".mcp.json" : from)));
  if (!filtered.length) fail(`no supported ${scope} JSON MCP source found for ${from}`);
  return filtered[0];
}

function mcpSync(args: string[]): void {
  const apply = applyRequired(args);
  const valueAfter = (flag: string, fallback: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
  const from = valueAfter("--from", "auto");
  const scope = valueAfter("--scope", existsSync(join(cwd, ".git")) ? "project" : "auto");
  const source = sourceForMcp(from, scope);
  const effectiveScope = scope === "auto" ? (source === join(cwd, ".mcp.json") || source.startsWith(`${join(cwd, ".opencode")}/`) ? "project" : "global") : scope;
  const requestedServer = valueAfter("--server", "");
  const allServers = normalizeMcpJson(source);
  const servers = requestedServer ? Object.fromEntries(Object.entries(allServers).filter(([name]) => name === requestedServer)) : allServers;
  if (requestedServer && !Object.keys(servers).length) fail(`MCP server not found in source: ${requestedServer}`);
  const requestedTarget = valueAfter("--target", "");
  const installed = detectedHarnesses().filter((item) => item.installed && ["claude", "grok", "gemini"].includes(item.id) && (!requestedTarget || item.id === requestedTarget));
  if (requestedTarget && !installed.length) fail(`MCP target not installed or unsupported: ${requestedTarget}`);
  const conflicts: string[] = [], missing: Array<{ harness: string; name: string }> = [];
  for (const target of installed) {
    const names = new Set(target.mcpFiles.flatMap(mcpInventory));
    for (const name of Object.keys(servers)) names.has(name) ? conflicts.push(`${target.id}:${name}`) : missing.push({ harness: target.id, name });
  }
  console.log(`Source: ${source} (${Object.keys(servers).length} servers); scope=${effectiveScope}`);
  console.log(`Missing: ${missing.map((item) => `${item.harness}:${item.name}`).join(", ") || "none"}`);
  console.log(`Existing names requiring semantic review: ${conflicts.join(", ") || "none"}`);
  if (!apply) return;
  if (conflicts.length) fail("existing server names require separate conflict confirmation; resolve or narrow source first");
  if (effectiveScope === "project" && hasSecretLiterals(servers)) {
    const projectTargets = [join(cwd, ".mcp.json"), join(cwd, ".grok", "config.toml"), join(cwd, ".gemini", "settings.json")];
    const unsafe = projectTargets.filter((path) => !gitIgnored(path));
    if (unsafe.length) fail(`secret-bearing project configs must be gitignored: ${unsafe.join(", ")}`);
  }
  const backupRoot = backup(installed.flatMap((item) => item.mcpFiles));
  try {
    for (const item of missing) {
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
