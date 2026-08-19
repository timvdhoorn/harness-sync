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

export type McpSource = { harness: string; path: string; scope: "project" | "global" };
type SkillIssue = { path: string; issue: string };
type MarketplaceSkill = { name: string; hash: string; status: "available" | "canonical" | "conflict"; sources: Array<{ harness: string; marketplace: string; plugin: string; path: string }> };
export type TrackedSkill = {
  source: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  skillPath: string | null;
  fullDepth?: boolean;
  version: string;
  contentHash: string;
  installedAt: string | null;
  updatedAt: string;
  provenance: "install" | "lock-import" | "scan";
};
export type SkillManifest = { version: 1; skills: Record<string, TrackedSkill> };
export type McpInstallation = {
  harness: string;
  path: string;
  scope: "project" | "global";
  configHash: string;
  effectiveConfigHash?: string;
  indirection?: { harness: "pi"; server: string; path: string };
};
export type McpAuditIssue = {
  issue: "non-portable-path" | "harness-coupled-launcher" | "missing-pi-server";
  harness: string;
  path: string;
  server: string;
  field: string;
  value: string;
  indirectHarnesses: string[];
  targetPath?: string;
};
export type TrackedMcp = {
  source: string | null;
  sourceType: "url" | "npm" | "pypi" | "docker" | null;
  configHash: string | null;
  conflict: boolean;
  installations: McpInstallation[];
  updatedAt: string;
  provenance: "inferred" | "scan";
};
export type McpManifest = { version: 1; servers: Record<string, TrackedMcp> };
export type McpTargetBinding = McpSource & { servers: Record<string, McpServer>; managedWrappers?: string[] };
export type McpResolution = { action: "variant" | "merge" | "skip"; variant?: string };
export type McpSyncPlan = {
  version: 1;
  mode: "interactive" | "non-interactive";
  apply: boolean;
  status: "ready-for-review" | "blocked-by-conflict";
  inventory: { source: string; identical: string[]; missing: string[]; conflicts: string[]; unrelated: string[] };
  operations: Array<{
    server: string;
    resolution: "identical" | "source" | "variant" | "reviewed-merge";
    definitionSource: string;
    targets: Array<{ binding: string; path: string; renderer: string }>;
    differingFields: string[];
    envKeys: string[];
    headerKeys: string[];
    preserve: string[];
  }>;
  unresolvedConflicts: Array<{
    server: string;
    variants: Array<{ id: string; harness: string; path: string }>;
    differingFields: string[];
    envKeys: string[];
    headerKeys: string[];
    collisions: string[];
  }>;
  skippedConflicts: string[];
  writes: [];
  requiresSeparateApplyConsent: boolean;
  exitCode: number;
};

const home = homedir();
const stateRoot = process.env.XDG_STATE_HOME
  ? join(process.env.XDG_STATE_HOME, "harness-sync")
  : join(home, ".local", "state", "harness-sync");
const canonicalSkills = join(home, ".agents", "skills");
const skillManifestPath = join(stateRoot, "skills.json");
const mcpManifestPath = join(stateRoot, "mcps.json");
const cwd = process.cwd();

export const harnesses: Harness[] = [
  { id: "codex", executable: "codex", skillDir: join(home, ".codex", "skills"), mcpFiles: [join(home, ".codex", "config.toml")], npxAgent: "codex" },
  { id: "claude", executable: "claude", skillDir: join(home, ".claude", "skills"), mcpFiles: [join(cwd, ".mcp.json"), join(home, ".claude.json")], npxAgent: "claude-code" },
  { id: "pi", executable: "pi", skillDir: join(home, ".pi", "agent", "skills"), mcpFiles: [join(home, ".pi", "mcp", "mcp.json")], npxAgent: "pi" },
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

function readSkillManifest(path = skillManifestPath): SkillManifest {
  if (!existsSync(path)) return { version: 1, skills: {} };
  const value = readJson(path);
  if (value?.version !== 1 || !value.skills || typeof value.skills !== "object") throw new Error(`invalid skill manifest: ${path}`);
  return value as SkillManifest;
}

function readMcpManifest(path = mcpManifestPath): McpManifest {
  if (!existsSync(path)) return { version: 1, servers: {} };
  const value = readJson(path);
  if (value?.version !== 1 || !value.servers || typeof value.servers !== "object") throw new Error(`invalid MCP manifest: ${path}`);
  return value as McpManifest;
}

function readSkillLocks(paths: string[]): Record<string, any> {
  const skills: Record<string, any> = {};
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try { Object.assign(skills, readJson(path).skills ?? {}); } catch { /* audit owns malformed lock reporting */ }
  }
  return skills;
}

export function scanSkillManifest(
  canonicalDir: string,
  lockPaths: string[],
  previous: SkillManifest = { version: 1, skills: {} },
  now = new Date().toISOString(),
): SkillManifest {
  const locks = readSkillLocks(lockPaths);
  const skills: Record<string, TrackedSkill> = {};
  if (!pathExists(canonicalDir)) return { version: 1, skills };
  for (const name of readdirSync(canonicalDir).sort()) {
    const path = join(canonicalDir, name);
    if (name.startsWith(".") || !validSkillName(name)) continue;
    try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
    const prior = previous.skills[name];
    const lock = locks[name];
    const contentHash = hashTree(path);
    skills[name] = {
      source: lock?.source ?? prior?.source ?? null,
      sourceType: lock?.sourceType ?? prior?.sourceType ?? null,
      sourceUrl: lock?.sourceUrl ?? prior?.sourceUrl ?? null,
      skillPath: lock?.skillPath ?? prior?.skillPath ?? null,
      ...(prior?.fullDepth ? { fullDepth: true } : {}),
      version: lock?.skillFolderHash ?? (prior?.contentHash === contentHash ? prior.version : contentHash),
      contentHash,
      installedAt: lock?.installedAt ?? prior?.installedAt ?? null,
      updatedAt: lock?.updatedAt ?? (prior?.contentHash === contentHash ? prior.updatedAt : now),
      provenance: prior?.provenance === "install" ? "install" : lock ? "lock-import" : "scan",
    };
  }
  return { version: 1, skills };
}

function globalSkillLocks(): string[] {
  return [join(home, ".agents", ".skill-lock.json"), join(cwd, "skills-lock.json")];
}

function currentSkillManifest(): SkillManifest {
  return scanSkillManifest(canonicalSkills, globalSkillLocks(), readSkillManifest());
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

export function piServerReference(server: McpServer): string | undefined {
  if (!server.command || basename(server.command) !== "agent-mcp-from-pi") return undefined;
  if (server.url || server.args?.length !== 1 || !server.args[0]) return undefined;
  return server.args[0];
}

function nonPortablePathValues(value: string, currentPlatform: NodeJS.Platform): string[] {
  if (currentPlatform !== "linux" || value === "~" || value.startsWith("~/")) return [];
  return value.match(/\/Users\/[^/:\s]+(?:\/[^:\n]*)?|\/opt\/homebrew(?:\/[^:\n]*)?/g) ?? [];
}

function harnessCoupledLauncherValues(value: string): string[] {
  return value.match(/(?:\$HOME|~|\/Users\/[^/:\s]+|\/home\/[^/:\s]+)\/\.agents\/(?:codex|claude|pi|grok|opencode|gemini|hermes|goose)\/[A-Za-z0-9._/-]+/g) ?? [];
}

export function inspectMcpConfigurations(
  sources: McpSource[],
  currentPlatform: NodeJS.Platform = platform(),
): McpAuditIssue[] {
  const loaded = sources.flatMap((source) => {
    if (!existsSync(source.path)) return [];
    try { return [{ source, servers: normalizeMcpFile(source.path) }]; } catch { return []; }
  });
  const pi = loaded.find((item) => item.source.harness === "pi" && item.source.scope === "global");
  const dependents = new Map<string, string[]>();
  const issues: McpAuditIssue[] = [];

  for (const item of loaded.filter((entry) => entry.source.harness === "codex")) {
    for (const [name, server] of Object.entries(item.servers)) {
      const reference = piServerReference(server);
      if (!reference) continue;
      const dependent = `${item.source.harness}:${name}`;
      dependents.set(reference, [...(dependents.get(reference) ?? []), dependent]);
      if (!pi?.servers[reference]) {
        issues.push({
          issue: "missing-pi-server",
          harness: item.source.harness,
          path: item.source.path,
          server: name,
          field: "args[0]",
          value: reference,
          indirectHarnesses: [dependent],
          targetPath: pi?.source.path ?? join(home, ".pi", "mcp", "mcp.json"),
        });
      }
    }
  }

  for (const item of loaded) {
    for (const [name, server] of Object.entries(item.servers)) {
      const fields: Array<[string, string]> = [
        ...(server.command ? [["command", server.command] as [string, string]] : []),
        ...(server.args ?? []).map((value, index) => [`args[${index}]`, value] as [string, string]),
        ...(server.cwd ? [["cwd", server.cwd] as [string, string]] : []),
        ...Object.entries(server.env ?? {})
          .filter(([key]) => !/(?:token|secret|password|passwd|api[_-]?key|authorization|credential)/i.test(key))
          .map(([key, value]) => [`env.${key}`, value] as [string, string]),
      ];
      for (const [field, value] of fields) {
        for (const launcher of harnessCoupledLauncherValues(value)) {
          issues.push({
            issue: "harness-coupled-launcher",
            harness: item.source.harness,
            path: item.source.path,
            server: name,
            field,
            value: launcher,
            indirectHarnesses: [],
          });
        }
        for (const offendingPath of nonPortablePathValues(value, currentPlatform)) {
          issues.push({
            issue: "non-portable-path",
            harness: item.source.harness,
            path: item.source.path,
            server: name,
            field,
            value: offendingPath,
            indirectHarnesses: item.source.harness === "pi" ? [...new Set(dependents.get(name) ?? [])].sort() : [],
          });
        }
      }
    }
  }
  return issues.sort((left, right) => `${left.path}:${left.server}:${left.field}`.localeCompare(`${right.path}:${right.server}:${right.field}`));
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
  const mcpManifest = scanMcpManifest(mcpSources(), readMcpManifest());
  const mcpIssues = inspectMcpConfigurations(mcpSources());
  const mcpProvenance = {
    path: mcpManifestPath,
    exists: existsSync(mcpManifestPath),
    servers: Object.keys(mcpManifest.servers).length,
    known: Object.values(mcpManifest.servers).filter((item) => item.source).length,
    unknown: Object.values(mcpManifest.servers).filter((item) => !item.source).length,
    conflicts: Object.entries(mcpManifest.servers).filter(([, item]) => item.conflict).map(([name]) => name),
  };
  const instructions = instructionTargets("all");
  const result = { canonicalSkills, canonicalExists: existsSync(canonicalSkills), canonicalIssues, skills, marketplaceSkills, mcp, mcpProvenance, mcpIssues, instructions };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Canonical skills: ${canonicalSkills} (${result.canonicalExists ? "ok" : "missing"})`);
    if (canonicalIssues.length) console.log(`canonical issues: ${canonicalIssues.length}`);
    for (const item of skills) console.log(`${item.id}: ${item.installed ? "installed" : "config-only"}; skill-issues=${item.issues.length}`);
    const candidates = marketplaceSkills.filter((item) => item.status !== "canonical");
    console.log(`marketplace skills: ${marketplaceSkills.length}; choices=${candidates.length}`);
    for (const item of mcp) console.log(`${item.harness}: ${item.servers.length} MCP server(s) in ${item.path}`);
    console.log(`MCP provenance: ${mcpProvenance.exists ? "initialized" : "missing"}; servers=${mcpProvenance.servers}; known=${mcpProvenance.known}; unknown=${mcpProvenance.unknown}; conflicts=${mcpProvenance.conflicts.length}`);
    for (const item of mcpIssues) {
      if (item.issue === "missing-pi-server") {
        console.log(`MCP indirection: ${item.path}: ${item.server} ${item.field}=${item.value} references missing Pi server in ${item.targetPath}; indirect harnesses=${item.indirectHarnesses.join(", ")}`);
      } else if (item.issue === "harness-coupled-launcher") {
        console.log(`MCP indirection: ${item.path}: ${item.server} ${item.field}=${item.value} depends on a harness-specific launcher`);
      } else {
        console.log(`MCP portability: ${item.path}: ${item.server} ${item.field}=${item.value} is not portable on ${platform()}; indirect harnesses=${item.indirectHarnesses.join(", ") || "none"}`);
      }
    }
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
  const before = currentSkillManifest();
  const backupRoot = backup([canonicalSkills, ...harnesses.map((item) => item.skillDir), skillManifestPath]);
  try {
    run(command);
    const after = scanSkillManifest(canonicalSkills, globalSkillLocks(), before);
    const selectedIndex = sourceArgs.indexOf("--skill");
    const selected = selectedIndex >= 0 ? new Set(sourceArgs.slice(selectedIndex + 1).filter((item) => !item.startsWith("--"))) : null;
    for (const [name, item] of Object.entries(after.skills)) {
      if ((selected?.has(name) || before.skills[name]?.contentHash !== item.contentHash || !before.skills[name]) && item.source) {
        item.provenance = "install";
        if (sourceArgs.includes("--full-depth")) item.fullDepth = true;
      }
    }
    writeJsonAtomic(skillManifestPath, after);
    cleanOldBackups();
    console.log(`Applied. Provenance: ${skillManifestPath}. Backup: ${backupRoot}`);
  } catch (error) {
    restoreBackup(backupRoot);
    throw new Error(`add failed; rolled back from ${backupRoot}: ${(error as Error).message}`);
  }
}

function npxLockOwns(name: string): boolean {
  for (const path of globalSkillLocks()) {
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

export function removeExistingPath(path: string): void {
  if (pathExists(path)) rmSync(path, { recursive: true, force: true });
}

function removeSkill(name: string, args: string[]): void {
  const apply = applyRequired(args);
  if (!validSkillName(name)) fail("invalid skill name");
  const targets = removalTargets(name);
  if (!targets.length) fail(`skill not found: ${name}`);
  console.log(`Plan: remove ${name} from ${targets.length} path(s):\n${targets.join("\n")}`);
  if (!apply) return;
  const backupRoot = backup([...targets, ...globalSkillLocks(), skillManifestPath]);
  try {
    if (npxLockOwns(name)) run(["npx", "--yes", "skills", "remove", name, "-g", "-y"]);
    for (const target of targets) removeExistingPath(target);
    const manifest = readSkillManifest();
    delete manifest.skills[name];
    writeJsonAtomic(skillManifestPath, manifest);
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
  const manifest = currentSkillManifest();
  const requested = cleanNames.length ? cleanNames : Object.keys(manifest.skills);
  const missing = requested.filter((name) => !manifest.skills[name]);
  if (missing.length) fail(`skills not found in manifest; run init first: ${missing.join(", ")}`);
  const unknown = requested.filter((name) => !manifest.skills[name].source);
  const tracked = requested.filter((name) => manifest.skills[name].source);
  for (const name of tracked) console.log(`Plan: update ${name} from ${manifest.skills[name].source} (current ${manifest.skills[name].version})`);
  if (unknown.length) console.log(`Skip (unknown source): ${unknown.join(", ")}`);
  if (cleanNames.length && unknown.length) fail(`cannot update skills with unknown source: ${unknown.join(", ")}`);
  if (!apply) return;
  const agents = detectedHarnesses().filter((item) => item.installed && item.npxAgent).map((item) => item.npxAgent!);
  const backupRoot = backup([...globalSkillLocks(), canonicalSkills, skillManifestPath]);
  try {
    for (const name of tracked) {
      const item = manifest.skills[name];
      run(["npx", "--yes", "skills", "add", item.source!, "--skill", name, ...(item.fullDepth ? ["--full-depth"] : []), "-g", "-y", "--agent", ...agents]);
    }
    const refreshed = scanSkillManifest(canonicalSkills, globalSkillLocks(), manifest);
    for (const name of tracked) refreshed.skills[name].provenance = "install";
    writeJsonAtomic(skillManifestPath, refreshed);
    cleanOldBackups();
    console.log(`Applied ${tracked.length} update(s). Provenance: ${skillManifestPath}. Backup: ${backupRoot}`);
  }
  catch (error) { restoreBackup(backupRoot); throw new Error(`update failed; rolled back from ${backupRoot}: ${(error as Error).message}`); }
}

function initState(args: string[]): void {
  const apply = applyRequired(args);
  const previous = readSkillManifest();
  const skillManifest = scanSkillManifest(canonicalSkills, globalSkillLocks(), previous);
  const mcpManifest = scanMcpManifest(mcpSources(), readMcpManifest());
  const knownSkills = Object.values(skillManifest.skills).filter((item) => item.source).length;
  const knownMcps = Object.values(mcpManifest.servers).filter((item) => item.source).length;
  const mcpConflicts = Object.values(mcpManifest.servers).filter((item) => item.conflict).length;
  console.log(`Plan: inventory ${Object.keys(skillManifest.skills).length} canonical skill(s); known source=${knownSkills}; unknown source=${Object.keys(skillManifest.skills).length - knownSkills}`);
  console.log(`Plan: inventory ${Object.keys(mcpManifest.servers).length} MCP server(s); known upstream=${knownMcps}; unknown upstream=${Object.keys(mcpManifest.servers).length - knownMcps}; conflicts=${mcpConflicts}`);
  if (!apply) return;
  const backupRoot = backup([skillManifestPath, mcpManifestPath]);
  try {
    writeJsonAtomic(skillManifestPath, skillManifest);
    writeJsonAtomic(mcpManifestPath, mcpManifest);
    cleanOldBackups();
    console.log(`Initialized ${skillManifestPath} and ${mcpManifestPath}. Backup: ${backupRoot}`);
  } catch (error) {
    restoreBackup(backupRoot);
    throw new Error(`init failed; rolled back from ${backupRoot}: ${(error as Error).message}`);
  }
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
    { harness: "catalog", path: join(root, "mcp.json"), scope: "project" },
    { harness: "pi", path: join(home, ".pi", "mcp", "mcp.json"), scope: "global" },
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
    pi: { global: join(home, ".pi", "mcp", "mcp.json") },
    hermes: { global: join(home, ".hermes", "config.yaml") },
    goose: { global: join(home, ".config", "goose", "config.yaml") },
    catalog: { project: join(root, "mcp.json"), global: "" },
  };
  return paths[harness]?.[scope] || undefined;
}

function codexSection(header: string): { server: string; field?: string } | undefined {
  const match = header.match(/^mcp_servers\.(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))(?:\.(env|http_headers))?$/);
  if (!match) return undefined;
  const server = match[1] !== undefined ? JSON.parse(`"${match[1]}"`) : match[2] ?? match[3];
  return { server, ...(match[4] ? { field: match[4] } : {}) };
}

function codexServerBlock(name: string, server: McpServer, unknownRoot: string[] = []): string {
  const line = (key: string, value: unknown) => `${key} = ${JSON.stringify(value)}`;
  const section = JSON.stringify(name);
  const values = [
    server.url ? line("url", server.url) : line("command", server.command),
    ...(server.args?.length ? [line("args", server.args)] : []),
    ...(server.cwd ? [line("cwd", server.cwd)] : []),
    line("enabled", server.enabled !== false),
    ...unknownRoot,
  ];
  let text = `[mcp_servers.${section}]\n${values.join("\n")}`;
  for (const [field, entries] of [["env", server.env], ["http_headers", server.headers]] as const) {
    if (!entries || !Object.keys(entries).length) continue;
    text += `\n\n[mcp_servers.${section}.${field}]\n${Object.entries(entries).map(([key, value]) => line(JSON.stringify(key), value)).join("\n")}`;
  }
  return text;
}

function updateCodexServer(text: string, name: string, server: McpServer): string {
  const sections = text.trimEnd().split(/(?=^\s*\[[^\]]+\]\s*$)/m);
  const kept: string[] = [];
  const unknownRoot: string[] = [];
  for (const section of sections) {
    const lines = section.trim().split("\n");
    const header = lines[0]?.trim().match(/^\[([^\]]+)\]$/)?.[1];
    const parsed = header ? codexSection(header) : undefined;
    if (parsed?.server !== name) {
      if (section.trim()) kept.push(section.trim());
      continue;
    }
    if (parsed.field === "env" || parsed.field === "http_headers") continue;
    if (!parsed.field) {
      unknownRoot.push(...lines.slice(1).filter((line) => !/^\s*(?:command|args|cwd|url|enabled)\s*=/.test(line)));
      continue;
    }
    kept.push(section.trim());
  }
  kept.push(codexServerBlock(name, server, unknownRoot));
  return `${kept.filter(Boolean).join("\n\n")}\n`;
}

function renderCodex(path: string, servers: Record<string, McpServer>): void {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [name, server] of Object.entries(servers)) text = updateCodexServer(text, name, server);
  writeTextAtomic(path, text);
}

function preserveUnknown(existing: unknown, known: string[]): Record<string, unknown> {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return {};
  return Object.fromEntries(Object.entries(existing as Record<string, unknown>).filter(([key]) => !known.includes(key)));
}

function renderOpenCode(path: string, servers: Record<string, McpServer>): void {
  const json: any = existsSync(path) ? (path.endsWith(".jsonc") ? Bun.JSONC.parse(readFileSync(path, "utf8")) : readJson(path)) : { $schema: "https://opencode.ai/config.json" };
  const v2 = Boolean(json.mcp?.servers);
  const target = v2 ? (json.mcp.servers ??= {}) : (json.mcp ??= {});
  for (const [name, server] of Object.entries(servers)) {
    const unknown = preserveUnknown(target[name], ["type", "command", "args", "cwd", "env", "environment", "envs", "url", "uri", "headers", "http_headers", "enabled", "disabled"]);
    target[name] = server.url
      ? { ...unknown, type: "remote", url: server.url, ...(server.headers ? { headers: server.headers } : {}), ...(v2 ? { disabled: server.enabled === false } : { enabled: server.enabled !== false }) }
      : { ...unknown, type: "local", command: [server.command, ...(server.args ?? [])], ...(server.cwd ? { cwd: server.cwd } : {}), ...(server.env ? { environment: server.env } : {}), ...(v2 ? { disabled: server.enabled === false } : { enabled: server.enabled !== false }) };
  }
  writeJsonAtomic(path, json);
}

function renderPi(path: string, servers: Record<string, McpServer>): void {
  const json: any = existsSync(path) ? readJson(path) : {};
  const target = json.mcpServers && typeof json.mcpServers === "object"
    ? json.mcpServers
    : json.mcp?.servers && typeof json.mcp.servers === "object"
      ? json.mcp.servers
      : json.mcp && typeof json.mcp === "object"
        ? json.mcp
        : (json.mcpServers = {});
  for (const [name, server] of Object.entries(servers)) {
    const existing = preserveUnknown(target[name], ["type", "command", "cmd", "args", "cwd", "env", "environment", "envs", "url", "uri", "headers", "http_headers", "enabled", "disabled"]);
    target[name] = {
      ...existing,
      ...(server.url
        ? { type: server.type ?? "http", url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
        : { type: "stdio", command: server.command, args: server.args ?? [], ...(server.cwd ? { cwd: server.cwd } : {}), ...(server.env ? { env: server.env } : {}) }),
      ...(server.enabled === false ? { enabled: false } : {}),
    };
  }
  writeJsonAtomic(path, json);
}

function renderYamlTarget(path: string, harness: "hermes" | "goose", servers: Record<string, McpServer>): void {
  const yaml: any = existsSync(path) ? Bun.YAML.parse(readFileSync(path, "utf8")) : {};
  const target = harness === "hermes" ? (yaml.mcp_servers ??= {}) : (yaml.extensions ??= {});
  for (const [name, server] of Object.entries(servers)) {
    const unknown = preserveUnknown(target[name], ["name", "type", "command", "cmd", "args", "cwd", "env", "environment", "envs", "url", "uri", "headers", "http_headers", "enabled", "disabled"]);
    target[name] = harness === "hermes"
      ? { ...unknown, ...(server.url ? { url: server.url } : { command: server.command, args: server.args ?? [] }), ...(server.env ? { env: server.env } : {}), ...(server.headers ? { headers: server.headers } : {}), enabled: server.enabled !== false }
      : { ...unknown, name, type: server.url ? "streamable_http" : "stdio", enabled: server.enabled !== false, ...(server.url ? { uri: server.url, ...(server.headers ? { headers: server.headers } : {}) } : { cmd: server.command, args: server.args ?? [], ...(server.env ? { envs: server.env } : {}) }) };
  }
  writeTextAtomic(path, Bun.YAML.stringify(yaml));
}

export function renderDirectTarget(harness: string, path: string, servers: Record<string, McpServer>): void {
  if (harness === "codex") return renderCodex(path, servers);
  if (harness === "pi" || harness === "catalog") return renderPi(path, servers);
  if (harness === "opencode") return renderOpenCode(path, servers);
  if (harness === "hermes" || harness === "goose") return renderYamlTarget(path, harness, servers);
  fail(`no direct MCP renderer for ${harness}`);
}

export function sourceForMcp(from: string, scope: string, sources = mcpSources(), base = cwd): McpSource {
  const looksLikePath = isAbsolute(from) || from.startsWith(".") || from.includes("/") || /\.(?:jsonc?|toml|ya?ml)$/i.test(from);
  const directPath = looksLikePath ? resolve(base, from) : "";
  if (directPath) {
    if (!existsSync(directPath)) fail(`MCP source not found: ${directPath}`);
    return { harness: "file", path: directPath, scope: scope === "auto" ? inferMcpScope(directPath, projectRoot()) : scope as "project" | "global" };
  }
  const choices = sources.filter((source) =>
    existsSync(source.path)
    && Object.keys(normalizeMcpFile(source.path)).length > 0
    && (scope === "auto" || source.scope === scope)
    && (from === "auto" || source.harness === from)
    && (from !== "auto" || source.harness !== "catalog")
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

function mcpConfigHash(server: McpServer): string {
  return createHash("sha256").update(JSON.stringify(semanticMcp(server))).digest("hex");
}

export function inferMcpUpstream(server: McpServer): Pick<TrackedMcp, "source" | "sourceType" | "provenance"> {
  if (server.url) return { source: server.url, sourceType: "url", provenance: "inferred" };
  const args = server.args ?? [];
  if (server.command === "npx" || server.command === "bunx") {
    const source = args.find((arg) => !arg.startsWith("-"));
    if (source) return { source, sourceType: "npm", provenance: "inferred" };
  }
  if (server.command === "uvx") {
    const source = args.find((arg) => !arg.startsWith("-"));
    if (source) return { source, sourceType: "pypi", provenance: "inferred" };
  }
  if (server.command === "docker" || server.command === "podman") {
    const runIndex = args.indexOf("run");
    const source = args.slice(runIndex >= 0 ? runIndex + 1 : 0).find((arg) => !arg.startsWith("-") && !arg.includes("="));
    if (source) return { source, sourceType: "docker", provenance: "inferred" };
  }
  return { source: null, sourceType: null, provenance: "scan" };
}

export function scanMcpManifest(
  sources: McpSource[],
  previous: McpManifest = { version: 1, servers: {} },
  now = new Date().toISOString(),
): McpManifest {
  const loaded = sources.flatMap((source) => {
    if (!existsSync(source.path)) return [];
    try { return [{ source, servers: normalizeMcpFile(source.path) }]; } catch { return []; }
  });
  const pi = loaded.find((item) => item.source.harness === "pi" && item.source.scope === "global");
  const found = new Map<string, Array<{ server: McpServer; installation: McpInstallation }>>();
  for (const { source, servers } of loaded) {
    for (const [name, rawServer] of Object.entries(servers)) {
      const reference = source.harness === "codex" ? piServerReference(rawServer) : undefined;
      const effectiveServer = reference && pi?.servers[reference] ? pi.servers[reference] : rawServer;
      const entries = found.get(name) ?? [];
      entries.push({
        server: effectiveServer,
        installation: {
          harness: source.harness,
          path: source.path,
          scope: source.scope,
          configHash: mcpConfigHash(rawServer),
          ...(effectiveServer !== rawServer ? {
            effectiveConfigHash: mcpConfigHash(effectiveServer),
            indirection: { harness: "pi", server: reference!, path: pi!.source.path },
          } : {}),
        },
      });
      found.set(name, entries);
    }
  }
  const servers: Record<string, TrackedMcp> = {};
  for (const [name, entries] of [...found].sort(([left], [right]) => left.localeCompare(right))) {
    const installations = entries.map((entry) => entry.installation).sort((left, right) => `${left.scope}:${left.harness}:${left.path}`.localeCompare(`${right.scope}:${right.harness}:${right.path}`));
    const hashes = [...new Set(installations.map((item) => item.effectiveConfigHash ?? item.configHash))];
    const inferred = entries.map((entry) => inferMcpUpstream(entry.server));
    const upstreams = [...new Set(inferred.filter((item) => item.source).map((item) => `${item.sourceType}:${item.source}`))];
    const conflict = (["project", "global"] as const).some((scope) => {
      const scoped = entries.filter((entry) => entry.installation.scope === scope);
      const scopedHashes = new Set(scoped.map((entry) => entry.installation.effectiveConfigHash ?? entry.installation.configHash));
      const scopedUpstreams = new Set(scoped.map((entry) => inferMcpUpstream(entry.server)).filter((item) => item.source).map((item) => `${item.sourceType}:${item.source}`));
      return scopedHashes.size > 1 || scopedUpstreams.size > 1;
    });
    const prior = previous.servers[name];
    const unchanged = prior && JSON.stringify(prior.installations) === JSON.stringify(installations);
    const selected = upstreams.length === 1 ? inferred.find((item) => item.source) : undefined;
    servers[name] = {
      source: selected?.source ?? null,
      sourceType: selected?.sourceType ?? null,
      configHash: hashes.length === 1 ? hashes[0] : null,
      conflict,
      installations,
      updatedAt: unchanged ? prior.updatedAt : now,
      provenance: selected?.provenance ?? "scan",
    };
  }
  return { version: 1, servers };
}

export function sameMcpServer(left: McpServer, right: McpServer): boolean {
  return JSON.stringify(semanticMcp(left)) === JSON.stringify(semanticMcp(right));
}

function effectiveMcpServers(harness: string, servers: Record<string, McpServer>): Record<string, McpServer> {
  if (harness !== "codex") return servers;
  const piPath = mcpTargetPath("pi", "global");
  if (!piPath || !existsSync(piPath)) return servers;
  let piServers: Record<string, McpServer>;
  try { piServers = normalizeMcpFile(piPath); } catch { return servers; }
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const reference = piServerReference(server);
    return [name, reference && piServers[reference] ? piServers[reference] : server];
  }));
}

function targetMcpServers(harness: string, scope: "project" | "global"): Record<string, McpServer> {
  const path = mcpTargetPath(harness, scope);
  return path && existsSync(path) ? effectiveMcpServers(harness, normalizeMcpFile(path)) : {};
}

const mcpSemanticFields = ["type", "command", "args", "cwd", "env", "url", "headers", "enabled"] as const;

function bindingId(binding: Pick<McpSource, "harness" | "path">): string {
  return `${binding.harness}:${binding.path}`;
}

function differingMcpFields(servers: McpServer[]): string[] {
  const semantic = servers.map((server) => semanticMcp(server) as Record<string, unknown>);
  return mcpSemanticFields.filter((field) => new Set(semantic.map((server) => JSON.stringify(server[field]))).size > 1);
}

function mergeMcpVariants(servers: McpServer[]): { server?: McpServer; collisions: string[] } {
  const merged: McpServer = {};
  const collisions: string[] = [];
  const atomic = ["command", "args", "cwd", "url", "type", "enabled"] as const;
  for (const field of atomic) {
    const present = servers.map((server) => server[field]).filter((value) => value !== undefined);
    const unique = [...new Map(present.map((value) => [JSON.stringify(value), value])).values()];
    if (unique.length > 1) collisions.push(field);
    else if (unique.length === 1) (merged as any)[field] = unique[0];
  }
  if (servers.some((server) => server.url) && servers.some((server) => server.command)) collisions.push("transport");
  for (const field of ["env"] as const) {
    const entries: Record<string, string> = {};
    for (const server of servers) {
      for (const [key, value] of Object.entries(server[field] ?? {})) {
        if (key in entries && entries[key] !== value) collisions.push(`${field}.${key}`);
        else entries[key] = value;
      }
    }
    if (Object.keys(entries).length) merged[field] = entries;
  }
  const headers = new Map<string, { key: string; value: string }>();
  for (const server of servers) {
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      const normalized = key.toLowerCase();
      const existing = headers.get(normalized);
      if (existing && existing.value !== value) collisions.push(`headers.${normalized}`);
      else if (!existing) headers.set(normalized, { key, value });
    }
  }
  if (headers.size) merged.headers = Object.fromEntries([...headers.values()].map(({ key, value }) => [key, value]));
  return { ...(collisions.length ? {} : { server: merged }), collisions: [...new Set(collisions)].sort() };
}

function rendererFor(harness: string): string {
  if (["claude", "grok", "gemini"].includes(harness)) return `${harness} native CLI`;
  if (harness === "catalog") return "harness-sync mcp.json";
  return `${harness} native config`;
}

export function mcpNativeCliCommand(
  harness: "claude" | "grok" | "gemini",
  scope: "project" | "global",
  name: string,
  server: McpServer,
): string[] {
  const transport = server.url ? (server.type === "sse" ? "sse" : "http") : "stdio";
  const envArgs = Object.entries(server.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const headerArgs = Object.entries(server.headers ?? {}).flatMap(([key, value]) => ["--header", `${key}: ${value}`]);
  const targetScope = scope === "global" ? "user" : "project";
  if (harness === "claude" || harness === "grok") {
    return [harness, "mcp", "add", "--scope", targetScope, "--transport", transport, ...envArgs, ...headerArgs, name, ...(server.url ? [server.url] : ["--", server.command!, ...(server.args ?? [])])];
  }
  return ["gemini", "mcp", "add", "--scope", targetScope, "--transport", transport, ...envArgs, ...headerArgs, name, ...(server.url ? [server.url] : [server.command!, ...(server.args ?? [])])];
}

export function buildMcpSyncPlan(
  source: McpTargetBinding,
  targets: McpTargetBinding[],
  resolutions: Record<string, McpResolution> = {},
  mode: "interactive" | "non-interactive" = "non-interactive",
): { plan: McpSyncPlan; definitions: Record<string, McpServer> } {
  const identical: string[] = [], missing: string[] = [], conflicts: string[] = [], unrelated: string[] = [];
  const operations: McpSyncPlan["operations"] = [], unresolvedConflicts: McpSyncPlan["unresolvedConflicts"] = [];
  const skippedConflicts: string[] = [], definitions: Record<string, McpServer> = {};
  const sourceId = bindingId(source);
  const sourceNames = new Set(Object.keys(source.servers));
  for (const target of targets) {
    for (const name of Object.keys(target.servers)) if (!sourceNames.has(name)) unrelated.push(`${target.harness}:${name}`);
  }

  for (const [name, sourceServer] of Object.entries(source.servers)) {
    for (const target of targets) {
      if (!target.servers[name]) missing.push(`${target.harness}:${name}`);
      else if (sameMcpServer(sourceServer, target.servers[name])) identical.push(`${target.harness}:${name}`);
    }
    const bindings = [
      { id: sourceId, harness: source.harness, path: source.path, server: sourceServer },
      ...targets.flatMap((target) => target.servers[name] ? [{ id: bindingId(target), harness: target.harness, path: target.path, server: target.servers[name] }] : []),
    ];
    const variants = bindings.filter((binding, index) => bindings.findIndex((candidate) => sameMcpServer(candidate.server, binding.server)) === index);
    const difference = differingMcpFields(variants.map((variant) => variant.server));
    const merge = mergeMcpVariants(variants.map((variant) => variant.server));
    const resolution = resolutions[name];
    let chosen = sourceServer;
    let resolutionName: McpSyncPlan["operations"][number]["resolution"] = "source";
    let definitionSource = sourceId;

    if (variants.length > 1) {
      conflicts.push(name);
      if (!resolution || resolution.action === "merge" && !merge.server) {
        unresolvedConflicts.push({
          server: name,
          variants: variants.map(({ id, harness, path }) => ({ id, harness, path })),
          differingFields: difference,
          envKeys: [...new Set(variants.flatMap((variant) => Object.keys(variant.server.env ?? {})))].sort(),
          headerKeys: [...new Set(variants.flatMap((variant) => Object.keys(variant.server.headers ?? {})))].sort(),
          collisions: merge.collisions,
        });
        continue;
      }
      if (resolution.action === "skip") {
        skippedConflicts.push(name);
        continue;
      }
      if (resolution.action === "merge") {
        chosen = merge.server!;
        resolutionName = "reviewed-merge";
        definitionSource = "reviewed-field-sources";
      } else {
        const selected = variants.find((variant) => variant.id === resolution.variant);
        if (!selected) {
          unresolvedConflicts.push({ server: name, variants: variants.map(({ id, harness, path }) => ({ id, harness, path })), differingFields: difference, envKeys: [], headerKeys: [], collisions: [`unknown variant ${resolution.variant ?? ""}`] });
          continue;
        }
        chosen = selected.server;
        definitionSource = selected.id;
        resolutionName = selected.id === sourceId ? "source" : "variant";
      }
    }

    const changedTargets = targets.filter((target) => {
      if (!target.servers[name]) return true;
      if (sameMcpServer(chosen, target.servers[name])) {
        return target.managedWrappers?.includes(name) ?? false;
      }
      return true;
    });
    if (!changedTargets.length) continue;
    definitions[name] = chosen;
    operations.push({
      server: name,
      resolution: variants.length === 1 ? "identical" : resolutionName,
      definitionSource,
      targets: changedTargets.map((target) => ({ binding: bindingId(target), path: target.path, renderer: rendererFor(target.harness) })),
      differingFields: difference,
      envKeys: Object.keys(chosen.env ?? {}).sort(),
      headerKeys: Object.keys(chosen.headers ?? {}).sort(),
      preserve: ["unrelated servers", "unknown native fields"],
    });
  }

  const blocked = unresolvedConflicts.length > 0;
  const plan: McpSyncPlan = {
    version: 1,
    mode,
    apply: false,
    status: blocked ? "blocked-by-conflict" : "ready-for-review",
    inventory: { source: sourceId, identical: [...new Set(identical)].sort(), missing: [...new Set(missing)].sort(), conflicts: [...new Set(conflicts)].sort(), unrelated: [...new Set(unrelated)].sort() },
    operations,
    unresolvedConflicts,
    skippedConflicts,
    writes: [],
    requiresSeparateApplyConsent: operations.length > 0,
    exitCode: blocked ? 2 : 0,
  };
  return { plan, definitions };
}

function mcpSync(args: string[]): void {
  const apply = applyRequired(args);
  const valueAfter = (flag: string, fallback: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
  const valuesAfter = (flag: string) => args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]] : []);
  const from = valueAfter("--from", "auto");
  const scope = valueAfter("--scope", "auto");
  const source = sourceForMcp(from, scope);
  const effectiveScope = scope === "auto" ? source.scope : scope;
  const requestedServer = valueAfter("--server", "");
  const allServers = effectiveMcpServers(source.harness, normalizeMcpFile(source.path));
  const servers = requestedServer ? Object.fromEntries(Object.entries(allServers).filter(([name]) => name === requestedServer)) : allServers;
  if (requestedServer && !Object.keys(servers).length) fail(`MCP server not found in source: ${requestedServer}`);
  const requestedTargets = valuesAfter("--target");
  const supportedTargets = ["codex", "claude", "pi", "grok", "opencode", "gemini", "hermes", "goose", "catalog"];
  const directTargets = new Set(["codex", "pi", "opencode", "hermes", "goose", "catalog"]);
  const detected = detectedHarnesses();
  const targetNames = requestedTargets.length
    ? [...new Set(requestedTargets)]
    : detected.filter((item) => item.installed && supportedTargets.includes(item.id)).map((item) => item.id);
  for (const target of targetNames) {
    if (!supportedTargets.includes(target)) fail(`unsupported MCP target: ${target}`);
    if (target !== "catalog" && !directTargets.has(target) && !detected.some((item) => item.id === target && item.installed)) fail(`MCP target not installed: ${target}`);
  }
  const unsupported = targetNames.filter((target) => !mcpTargetPath(target, effectiveScope)).map((target) => `${target}:${effectiveScope}`);
  const replaceWrappers = args.includes("--direct");
  const targets: McpTargetBinding[] = targetNames.flatMap((harness) => {
    const path = mcpTargetPath(harness, effectiveScope as "project" | "global");
    if (!path) return [];
    const raw = existsSync(path) ? normalizeMcpFile(path) : {};
    const effective = harness === "codex" ? effectiveMcpServers(harness, raw) : raw;
    const managedWrappers = replaceWrappers && harness === "codex"
      ? Object.entries(raw).filter(([, server]) => piServerReference(server)).map(([name]) => name)
      : [];
    return [{ harness, path, scope: effectiveScope as "project" | "global", servers: effective, managedWrappers }];
  });
  const sourceBinding: McpTargetBinding = { ...source, servers };
  const resolutions: Record<string, McpResolution> = {};
  for (const raw of valuesAfter("--resolve")) {
    const separator = raw.indexOf("=");
    if (separator < 1) fail(`invalid --resolve value: ${raw}`);
    const name = raw.slice(0, separator), choice = raw.slice(separator + 1);
    if (choice === "skip" || choice === "merge") resolutions[name] = { action: choice };
    else if (choice === "source") resolutions[name] = { action: "variant", variant: bindingId(sourceBinding) };
    else if (choice.startsWith("target:")) {
      const target = targets.find((item) => item.harness === choice.slice("target:".length));
      if (!target) fail(`unknown target variant for ${name}: ${choice}`);
      resolutions[name] = { action: "variant", variant: bindingId(target) };
    } else fail(`unknown conflict resolution for ${name}: ${choice}`);
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !args.includes("--non-interactive"));
  let built = buildMcpSyncPlan(sourceBinding, targets, resolutions, interactive ? "interactive" : "non-interactive");
  if (interactive) {
    for (const conflict of built.plan.unresolvedConflicts) {
      console.log(`Conflict ${conflict.server}: fields=${conflict.differingFields.join(", ")}; env keys=${conflict.envKeys.join(", ") || "none"}; header keys=${conflict.headerKeys.join(", ") || "none"}; collisions=${conflict.collisions.join(", ") || "none"}`);
      conflict.variants.forEach((variant, index) => console.log(`  ${index + 1}) ${variant.id}`));
      const mergeOption = conflict.collisions.length ? "" : ", m=review safe merge";
      const answer = globalThis.prompt?.(`Choose 1-${conflict.variants.length}${mergeOption}, s=skip:`)?.trim().toLowerCase();
      if (answer === "s") resolutions[conflict.server] = { action: "skip" };
      else if (answer === "m" && !conflict.collisions.length) resolutions[conflict.server] = { action: "merge" };
      else {
        const variant = conflict.variants[Number(answer) - 1];
        if (variant) resolutions[conflict.server] = { action: "variant", variant: variant.id };
      }
    }
    built = buildMcpSyncPlan(sourceBinding, targets, resolutions, "interactive");
  }
  console.log(`Source: ${source.harness}:${source.path} (${Object.keys(servers).length} servers); scope=${effectiveScope}`);
  console.log(`Missing: ${built.plan.inventory.missing.join(", ") || "none"}`);
  console.log(`Identical: ${built.plan.inventory.identical.join(", ") || "none"}`);
  console.log(`Conflicts: ${built.plan.inventory.conflicts.join(", ") || "none"}`);
  console.log(`Unsupported scope: ${unsupported.join(", ") || "none"}`);
  console.log(JSON.stringify({ ...built.plan, apply }, null, 2));
  if (built.plan.status === "blocked-by-conflict") {
    process.exitCode = built.plan.exitCode;
    return;
  }
  if (!apply) return;
  if (unsupported.length) fail(`target does not support ${effectiveScope} MCP scope; no config was written: ${unsupported.join(", ")}`);
  const targetPaths = [...new Set(built.plan.operations.flatMap((operation) => operation.targets.map((target) => target.path)))];
  if (effectiveScope === "project" && hasSecretLiterals(built.definitions)) {
    const unsafe = targetPaths.filter((path) => !gitIgnored(path));
    if (unsafe.length) fail(`secret-bearing project configs must be gitignored: ${unsafe.join(", ")}`);
  }
  const backupRoot = backup([...targetPaths, mcpManifestPath]);
  try {
    for (const harness of ["codex", "pi", "opencode", "hermes", "goose", "catalog"]) {
      const target = targets.find((item) => item.harness === harness);
      const selected = Object.fromEntries(built.plan.operations.filter((operation) => operation.targets.some((item) => item.binding === (target ? bindingId(target) : ""))).map((operation) => [operation.server, built.definitions[operation.server]]));
      const path = target?.path;
      if (path && Object.keys(selected).length) renderDirectTarget(harness, path, selected);
    }
    for (const operation of built.plan.operations) for (const plannedTarget of operation.targets) {
      const target = targets.find((item) => bindingId(item) === plannedTarget.binding)!;
      if (directTargets.has(target.harness)) continue;
      const server = built.definitions[operation.server];
      if (["claude", "grok", "gemini"].includes(target.harness)) {
        run(mcpNativeCliCommand(target.harness as "claude" | "grok" | "gemini", effectiveScope as "project" | "global", operation.server, server));
        if (existsSync(target.path)) chmodSync(target.path, 0o600);
      }
    }
    writeJsonAtomic(mcpManifestPath, scanMcpManifest(mcpSources(), readMcpManifest()));
    cleanOldBackups();
    console.log(`Applied ${built.plan.operations.reduce((count, operation) => count + operation.targets.length, 0)} MCP binding(s). Provenance: ${mcpManifestPath}. Backup: ${backupRoot}`);
  } catch (error) {
    restoreBackup(backupRoot);
    throw new Error(`MCP sync failed; rolled back from ${backupRoot}: ${(error as Error).message}`);
  }
}

function usage(): void {
  console.log(`harness-sync [audit|init|instructions|add|remove|update|mcp]\n\nRecommended: audit\nRun a command without --apply for a plan. Writes require --apply --confirmed.`);
}

export function main(argv = process.argv.slice(2)): void {
  const [command, ...args] = argv;
  try {
    if (!command || command === "--help" || command === "-h") return usage();
    if (command === "audit") return audit(args.includes("--json"));
    if (command === "init") return initState(args);
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
