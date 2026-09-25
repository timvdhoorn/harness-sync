#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
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
import { arch, homedir, hostname, platform } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  nativeSkills?: boolean;
  legacySkillDir?: string;
  mcpFiles: string[];
  npxAgent?: string;
};

export type McpSource = { harness: string; path: string; scope: "project" | "global" };
type SkillIssue = { path: string; issue: string };
export type HookAuditIssue = {
  issue: "invalid-json" | "absolute-home-path" | "machine-local-executable" | "missing-target";
  path: string;
  event: string;
  hook: number;
  field: "command";
};
export type PortableConfigEntry = { source: string; target: string; format: "json" | "text"; mode: "0600" };
export type PortableConfigManifest = { version: 1; configs: Record<string, PortableConfigEntry> };
export type PortableConfigIssue = {
  issue: "source-missing" | "target-missing" | "target-drift" | "target-not-ignored" | "source-non-portable";
  id: string;
  path: string;
};
type MarketplaceSkill = { name: string; hash: string; status: "available" | "canonical" | "conflict"; sources: Array<{ harness: string; marketplace: string; plugin: string; path: string }> };
type StrictAuditFinding = { code: string; path: string; server?: string; field?: string; scope?: McpSource["scope"]; event?: string; hook?: number; id?: string };
type StrictAuditSummary = { actionable: boolean; findings: StrictAuditFinding[] };
export type TrackedSkill = {
  source: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  skillPath: string | null;
  installSource?: string;
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
  issue: "non-portable-path" | "harness-coupled-launcher" | "missing-pi-server" | "app-owned-harness" | "app-owned-platform";
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
type AppOwnedMcp = { owner: "codex"; platform: "darwin"; field: "command"; value: string };
type McpCompatibilityReason = "requires-codex" | "requires-darwin" | "preserve-app-owned";
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
  skippedIncompatible: Array<{
    server: string;
    binding: string;
    reasons: McpCompatibilityReason[];
  }>;
  writes: [];
  requiresSeparateApplyConsent: boolean;
  exitCode: number;
};
export type McpRemovalPlan = {
  version: 1;
  action: "remove";
  apply: boolean;
  status: "ready-for-review";
  scope: "project" | "global";
  servers: string[];
  operations: Array<{
    server: string;
    targets: Array<{ binding: string; path: string; renderer: string }>;
    preserve: string[];
  }>;
  missing: string[];
  writes: [];
  requiresSeparateApplyConsent: boolean;
  exitCode: 0;
};

const home = homedir();
const stateRoot = process.env.XDG_STATE_HOME
  ? join(process.env.XDG_STATE_HOME, "harness-sync")
  : join(home, ".local", "state", "harness-sync");
const canonicalSkills = join(home, ".agents", "skills");
const skillManifestPath = join(stateRoot, "skills.json");
const mcpManifestPath = join(stateRoot, "mcps.json");
const portableConfigManifestPath = join(home, ".agents", "harness-sync", "portable-configs.json");
const cwd = process.cwd();

export const harnesses: Harness[] = [
  { id: "codex", executable: "codex", skillDir: join(home, ".codex", "skills"), mcpFiles: [join(home, ".codex", "config.toml")], npxAgent: "codex" },
  { id: "claude", executable: "claude", skillDir: join(home, ".claude", "skills"), mcpFiles: [join(cwd, ".mcp.json"), join(home, ".claude.json")], npxAgent: "claude-code" },
  { id: "pi", executable: "pi", skillDir: join(home, ".pi", "agent", "skills"), mcpFiles: [join(home, ".pi", "mcp", "mcp.json")], npxAgent: "pi" },
  { id: "grok", executable: "grok", skillDir: join(home, ".grok", "skills"), mcpFiles: [join(cwd, ".grok", "config.toml"), join(home, ".grok", "config.toml")], npxAgent: "grok" },
  {
    id: "opencode",
    executable: "opencode",
    skillDir: canonicalSkills,
    nativeSkills: true,
    legacySkillDir: join(home, ".config", "opencode", "skills"),
    mcpFiles: [join(cwd, ".opencode", "opencode.json"), join(home, ".config", "opencode", "opencode.json")],
  },
  { id: "gemini", executable: "gemini", skillDir: join(home, ".gemini", "skills"), mcpFiles: [join(cwd, ".gemini", "settings.json"), join(home, ".gemini", "settings.json")], npxAgent: "gemini-cli" },
  { id: "hermes", executable: "hermes", skillDir: join(home, ".hermes", "skills"), mcpFiles: [join(home, ".hermes", "config.yaml")], npxAgent: "hermes-agent" },
  { id: "goose", executable: "goose", skillDir: join(home, ".config", "goose", "skills"), mcpFiles: [join(home, ".config", "goose", "config.yaml")], npxAgent: "goose" },
];

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function commandExists(command: string): boolean {
  const candidates = command.includes("/") ? [command] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((directory) => {
    if (platform() !== "win32") return [join(directory, command)];
    return (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((extension) => join(directory, `${command}${extension.toLowerCase()}`));
  });
  return candidates.some((candidate) => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  });
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
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(path: string, value: string): void {
  const destination = writeDestination(path);
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.harness-sync-${process.pid}`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, destination);
  chmodSync(destination, 0o600);
}

function writeDestination(path: string): string {
  if (!pathExists(path) || !lstatSync(path).isSymbolicLink()) return path;
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`refusing to replace dangling symlink: ${path}`);
  }
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function backupSources(paths: string[]): string[] {
  const sources: string[] = [];
  for (const path of new Set(paths)) {
    sources.push(path);
    if (!pathExists(path) || !lstatSync(path).isSymbolicLink()) continue;
    try {
      sources.push(realpathSync(path));
    } catch { /* a dangling link has no target to preserve */ }
  }
  return [...new Set(sources)];
}

function backup(paths: string[]): string {
  const root = join(stateRoot, "backups", timestamp());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const manifest: Array<{ source: string; backup?: string; kind: "file" | "directory" | "symlink" | "missing" }> = [];
  for (const source of backupSources(paths)) {
    if (!pathExists(source)) {
      manifest.push({ source, kind: "missing" });
      continue;
    }
    const target = join(root, createHash("sha256").update(source).digest("hex").slice(0, 16));
    const info = lstatSync(source);
    const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file";
    cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
    manifest.push({ source, backup: target, kind });
  }
  writeJsonAtomic(join(root, "manifest.json"), manifest);
  return root;
}

function restoreBackup(root: string): void {
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) return;
  const manifest = readJson(manifestPath) as Array<{ source: string; backup?: string; kind: string }>;
  const failed: string[] = [];
  for (const item of manifest.reverse()) {
    try {
      if (item.kind === "file" && item.backup && pathExists(item.source) && lstatSync(item.source).isFile() && hashFile(item.source) === hashFile(item.backup)) continue;
      if (pathExists(item.source)) rmSync(item.source, { recursive: true, force: true });
      if (item.kind === "missing" || !item.backup) continue;
      mkdirSync(dirname(item.source), { recursive: true });
      cpSync(item.backup, item.source, { recursive: true, dereference: false, verbatimSymlinks: true });
    } catch (error) {
      failed.push(`${item.source} (${(error as Error).message})`);
    }
  }
  if (failed.length) throw new Error(`could not restore ${failed.join("; ")}`);
}

function withBackup(label: string, paths: string[], action: () => void): string {
  const root = backup(paths);
  try {
    action();
  } catch (error) {
    const reason = (error as Error).message;
    try {
      restoreBackup(root);
    } catch (restoreError) {
      throw new Error(`${label} failed and rollback from ${root} also failed (${(restoreError as Error).message}): ${reason}`);
    }
    throw new Error(`${label} failed; rolled back from ${root}: ${reason}`);
  }
  cleanOldBackups();
  return root;
}

function cleanOldBackups(): void {
  const root = join(stateRoot, "backups");
  if (!existsSync(root)) return;
  const entries = readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(name)).sort().reverse();
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
      ...(prior?.installSource ? { installSource: prior.installSource } : {}),
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

export function embeddedSkillPaths(skillDir: string): string[] {
  const embedded: string[] = [];
  const visit = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const child = join(path, name);
      let info;
      try { info = lstatSync(child); } catch { continue; }
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (existsSync(join(child, "SKILL.md"))) embedded.push(relative(skillDir, join(child, "SKILL.md")));
      visit(child);
    }
  };
  if (pathExists(skillDir)) visit(skillDir);
  return embedded;
}

export function inspectCanonicalSkillDirectory(canonicalDir = canonicalSkills): SkillIssue[] {
  if (!pathExists(canonicalDir)) return [{ path: canonicalDir, issue: "missing-directory" }];
  return readdirSync(canonicalDir).sort().flatMap((name) => {
    const path = join(canonicalDir, name);
    if (name.startsWith(".")) return [];
    let info;
    try { info = lstatSync(path); } catch { return []; }
    if (!info.isDirectory() && !info.isSymbolicLink()) return [];
    const metadataIssue = skillMetadataIssue(path, name);
    const issues: SkillIssue[] = metadataIssue ? [{ path, issue: metadataIssue }] : [];
    return issues.concat(embeddedSkillPaths(path).map((embedded) => ({
      path: join(path, embedded),
      issue: "embedded-skill",
    })));
  });
}

function assertStandaloneSkills(names: Iterable<string>): void {
  const issues = [...new Set(names)].flatMap((name) => embeddedSkillPaths(join(canonicalSkills, name)).map((path) => `${name}/${path}`));
  if (issues.length) {
    throw new Error(`installed skill contains embedded skills (${issues.join(", ")}); use a repository tree URL that points to the standalone skill directory`);
  }
}

export function skillInstallSource(item: TrackedSkill): string | null {
  return item.installSource ?? item.source;
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

export function inspectHarnessSkillDirectory(
  harness: Pick<Harness, "skillDir" | "nativeSkills" | "legacySkillDir">,
  canonicalDir = canonicalSkills,
): SkillIssue[] {
  if (!harness.nativeSkills) return inspectSkillDirectory(harness.skillDir, canonicalDir);
  const legacy = harness.legacySkillDir;
  if (!legacy || !pathExists(legacy)) return [];
  try {
    if (lstatSync(legacy).isSymbolicLink() && realpathSync(legacy) === realpathSync(canonicalDir)) {
      return [{ path: legacy, issue: "redundant-directory-link" }];
    }
  } catch { /* a broken legacy path is not part of native skill discovery */ }
  return [];
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

const piWrapperHarnesses = new Set(["codex", "grok"]);

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

const computerUseLauncher = "Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const userCodexComputerUseLauncher = /^\/Users\/[^/]+\/\.codex\/(?:(?!\.{1,2}\/)[^/]+\/)*Codex Computer Use\.app\/Contents\/SharedSupport\/SkyComputerUseClient\.app\/Contents\/MacOS\/SkyComputerUseClient$/;

export function classifyAppOwnedMcp(server: McpServer): AppOwnedMcp | undefined {
  const command = server.command;
  if (!command) return undefined;
  if (/^\/Applications\/(?:ChatGPT|Codex)\.app\/Contents\/Resources\/cua_node\/bin\/node_repl$/.test(command)) {
    return { owner: "codex", platform: "darwin", field: "command", value: command };
  }
  const relativeComputerUse = command === `./${computerUseLauncher}`;
  const userCodexComputerUse = userCodexComputerUseLauncher.test(command);
  if (
    server.args?.length === 1
    && server.args[0] === "mcp"
    && (relativeComputerUse || userCodexComputerUse)
  ) {
    return { owner: "codex", platform: "darwin", field: "command", value: command };
  }
  return undefined;
}

function appOwnedMcpCompatibility(
  server: McpServer,
  harness: string,
  currentPlatform: NodeJS.Platform,
): McpCompatibilityReason[] {
  const ownership = classifyAppOwnedMcp(server);
  if (!ownership) return [];
  return [
    ...(harness === ownership.owner ? [] : ["requires-codex" as const]),
    ...(currentPlatform === ownership.platform ? [] : ["requires-darwin" as const]),
  ];
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

  for (const item of loaded.filter((entry) => piWrapperHarnesses.has(entry.source.harness))) {
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
      const appOwnership = classifyAppOwnedMcp(server);
      if (appOwnership && item.source.harness !== appOwnership.owner) {
        issues.push({
          issue: "app-owned-harness",
          harness: item.source.harness,
          path: item.source.path,
          server: name,
          field: appOwnership.field,
          value: appOwnership.value,
          indirectHarnesses: [],
        });
      }
      if (appOwnership && currentPlatform !== appOwnership.platform) {
        issues.push({
          issue: "app-owned-platform",
          harness: item.source.harness,
          path: item.source.path,
          server: name,
          field: appOwnership.field,
          value: appOwnership.value,
          indirectHarnesses: [],
        });
      }
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
  status: "missing-agents" | "missing-claude" | "correct-link" | "correct-import" | "wrong-link" | "conflict";
};

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function insidePath(path: string, parent: string): boolean {
  const child = resolve(path);
  const root = resolve(parent);
  return child === root || child.startsWith(`${root}/`);
}

export function findSyncthingRoot(path: string, boundary = home): string | undefined {
  let current = pathExists(path) && lstatSync(path).isDirectory() ? resolve(path) : dirname(resolve(path));
  const limit = resolve(boundary);
  while (insidePath(current, limit)) {
    if (pathExists(join(current, ".stfolder"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!commandExists("syncthing")) return undefined;
  const listed = Bun.spawnSync(["syncthing", "cli", "config", "folders", "list"], { stdout: "pipe", stderr: "ignore" });
  if (listed.exitCode !== 0) return undefined;
  const roots = listed.stdout.toString().trim().split(/\s+/).flatMap((id) => {
    if (!id) return [];
    const result = Bun.spawnSync(["syncthing", "cli", "config", "folders", id, "path", "get"], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return [];
    const configured = result.stdout.toString().trim();
    const expanded = configured === "~" ? limit : configured.startsWith("~/") ? join(limit, configured.slice(2)) : resolve(configured);
    return insidePath(expanded, limit) ? [expanded] : [];
  }).sort((left, right) => right.length - left.length);
  return roots.find((root) => insidePath(path, root));
}

type HookCommand = { event: string; hook: number; command: string };

function hookCommands(config: any): HookCommand[] {
  if (!config || typeof config !== "object" || !config.hooks || typeof config.hooks !== "object") return [];
  const commands: HookCommand[] = [];
  for (const [event, registrations] of Object.entries(config.hooks)) {
    if (!Array.isArray(registrations)) continue;
    let hook = 0;
    for (const registration of registrations) {
      const entries = Array.isArray((registration as any)?.hooks) ? (registration as any).hooks : [];
      for (const entry of entries) {
        if (typeof entry?.command === "string") commands.push({ event, hook, command: entry.command });
        hook++;
      }
    }
  }
  return commands;
}

function guardedHookCommand(command: string): boolean {
  return /(?:command\s+-v|\btest\s+-[efx]\b|\[\[?\s+-[efx]\s|\|\|\s*(?:true|printf|exit\s+0)|\bif\s+\[)/.test(command);
}

export function inspectHookConfiguration(
  path: string,
  options: { shared?: boolean; userHome?: string; syncedRoot?: string } = {},
): HookAuditIssue[] {
  if (!pathExists(path)) return [];
  let config: any;
  try { config = readJson(path); } catch {
    return [{ issue: "invalid-json", path, event: "config", hook: 0, field: "command" }];
  }
  const userHome = options.userHome ?? home;
  const shared = options.shared ?? Boolean(options.syncedRoot ?? findSyncthingRoot(path, userHome));
  const issues: HookAuditIssue[] = [];
  for (const item of hookCommands(config)) {
    if (shared && /\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(item.command)) {
      issues.push({ issue: "absolute-home-path", path, event: item.event, hook: item.hook, field: "command" });
    }
    if (shared && /(?:^|[\s"'])(?:\/opt\/homebrew|\/usr\/local)\//.test(item.command)) {
      issues.push({ issue: "machine-local-executable", path, event: item.event, hook: item.hook, field: "command" });
    }
    if (!guardedHookCommand(item.command)) {
      const references = [...item.command.matchAll(/(?:\$\{HOME\}|\$HOME)(\/[A-Za-z0-9._@%+,:=~\/-]+)/g)];
      for (const match of references) {
        const suffix = match[1].replace(/[)'";]+$/, "");
        if (suffix && !pathExists(join(userHome, suffix))) {
          issues.push({ issue: "missing-target", path, event: item.event, hook: item.hook, field: "command" });
          break;
        }
      }
    }
  }
  return issues.sort((left, right) => `${left.path}:${left.event}:${left.hook}:${left.issue}`.localeCompare(`${right.path}:${right.event}:${right.hook}:${right.issue}`));
}

function homePortablePath(path: string, userHome = home): string {
  const absolute = resolve(path);
  return insidePath(absolute, userHome) ? `~/${relative(userHome, absolute)}` : absolute;
}

function resolvePortablePath(path: string, userHome = home): string {
  return path === "~" ? userHome : path.startsWith("~/") ? join(userHome, path.slice(2)) : resolve(path);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readPortableConfigManifest(path = portableConfigManifestPath): PortableConfigManifest {
  if (!existsSync(path)) return { version: 1, configs: {} };
  const value = readJson(path);
  if (value?.version !== 1 || !value.configs || typeof value.configs !== "object") throw new Error(`invalid portable config manifest: ${path}`);
  return value;
}

function exactSyncthingIgnore(root: string, target: string): string {
  return `/${relative(root, target).replaceAll("\\", "/")}`;
}

function targetIsIgnored(target: string, userHome = home): boolean {
  const root = findSyncthingRoot(target, userHome);
  if (!root) return true;
  const ignore = join(root, ".stignore");
  if (!existsSync(ignore)) return false;
  const pattern = exactSyncthingIgnore(root, target);
  return readFileSync(ignore, "utf8").split(/\r?\n/).map((line) => line.trim()).includes(pattern);
}

function ensureTargetIgnored(target: string, userHome = home): string | undefined {
  const root = findSyncthingRoot(target, userHome);
  if (!root) return undefined;
  const ignore = join(root, ".stignore");
  const pattern = exactSyncthingIgnore(root, target);
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!current.split(/\r?\n/).map((line) => line.trim()).includes(pattern)) {
    const separator = current.length && !current.endsWith("\n") ? "\n" : "";
    writeTextAtomic(ignore, `${current}${separator}\n// Rendered locally by harness-sync\n${pattern}\n`);
  }
  return ignore;
}

export function inspectPortableConfigs(
  manifest: PortableConfigManifest,
  options: { userHome?: string } = {},
): PortableConfigIssue[] {
  const userHome = options.userHome ?? home;
  const issues: PortableConfigIssue[] = [];
  for (const [id, entry] of Object.entries(manifest.configs)) {
    const source = resolvePortablePath(entry.source, userHome);
    const target = resolvePortablePath(entry.target, userHome);
    if (!existsSync(source)) {
      issues.push({ issue: "source-missing", id, path: source });
      continue;
    }
    if (entry.format === "json" && inspectHookConfiguration(source, { shared: true, userHome }).length) {
      issues.push({ issue: "source-non-portable", id, path: source });
    }
    if (!existsSync(target)) issues.push({ issue: "target-missing", id, path: target });
    else if (hashFile(source) !== hashFile(target)) issues.push({ issue: "target-drift", id, path: target });
    if (!targetIsIgnored(target, userHome)) issues.push({ issue: "target-not-ignored", id, path: target });
  }
  return issues.sort((left, right) => `${left.id}:${left.issue}`.localeCompare(`${right.id}:${right.issue}`));
}

function projectRoot(): string {
  if (!commandExists("git")) return cwd;
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : cwd;
}

export function inspectInstructions(root: string, agents = join(root, "AGENTS.md"), claude = join(root, "CLAUDE.md")): InstructionsStatus {
  if (!pathExists(agents)) return { root, agents, claude, status: "missing-agents" };
  if (!pathExists(claude)) return { root, agents, claude, status: "missing-claude" };
  if (!lstatSync(claude).isSymbolicLink()) {
    if (!lstatSync(claude).isFile()) return { root, agents, claude, status: "conflict" };
    let fence: string | undefined;
    for (const line of readFileSync(claude, "utf8").split(/\r?\n/)) {
      const marker = line.trim().match(/^(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
        continue;
      }
      if (fence) continue;
      const match = line.match(/^@(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/);
      if (!match) continue;
      const source = match[1] ?? match[2] ?? match[3];
      const imported = source.startsWith("~/") ? join(home, source.slice(2)) : resolve(dirname(claude), source);
      try {
        if (realpathSync(imported) === realpathSync(agents)) return { root, agents, claude, status: "correct-import" };
      } catch { /* A missing or unrelated import is not a canonical wrapper. */ }
    }
    return { root, agents, claude, status: "conflict" };
  }
  try {
    return { root, agents, claude, status: realpathSync(claude) === realpathSync(agents) ? "correct-link" : "wrong-link" };
  } catch {
    return { root, agents, claude, status: "wrong-link" };
  }
}

export function inspectUserInstructions(userHome: string): InstructionsStatus[] {
  const targets = [inspectInstructions(userHome)];
  const shared = join(userHome, ".agents", "AGENTS.md");
  if (pathExists(shared)) targets.push(inspectInstructions(join(userHome, ".agents"), shared, join(userHome, ".claude", "CLAUDE.md")));
  return targets;
}

function instructionTargets(scope: string): InstructionsStatus[] {
  const targets = scope === "project" ? [inspectInstructions(projectRoot())] : scope === "user" ? inspectUserInstructions(home) : [inspectInstructions(projectRoot()), ...inspectUserInstructions(home)];
  return targets.filter((item, index) => targets.findIndex((other) => other.claude === item.claude) === index);
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
  const backupRoot = withBackup("instruction sync", changes.map((item) => item.claude), () => {
    for (const item of changes) {
      if (pathExists(item.claude)) rmSync(item.claude, { recursive: true, force: true });
      mkdirSync(dirname(item.claude), { recursive: true });
      symlinkSync(relative(dirname(item.claude), item.agents), item.claude);
    }
  });
  console.log(`Applied ${changes.length} instruction link(s). Backup: ${backupRoot}`);
}

function strictSkillIssueCode(issue: string, canonical: boolean): string | undefined {
  if (issue === "missing-directory") return canonical ? "canonical-missing" : undefined;
  if (issue === "embedded-skill") return canonical ? "canonical-nested-skill" : "skill-nested-skill";
  if (["broken-directory-link", "wrong-directory-link", "broken-skill-link", "wrong-skill-link"].includes(issue)) {
    return `skill-${issue}`;
  }
  if (issue === "copy-drift") return "skill-copy-drift";
  if (issue === "redundant-directory-link") return "skill-redundant-directory-link";
  if (issue === "copy" || issue === "untracked-copy") return undefined;
  return canonical || issue.includes("SKILL.md") || issue.includes("frontmatter") || issue.startsWith("name-mismatch:")
    ? canonical ? "canonical-invalid-metadata" : "skill-invalid-metadata"
    : undefined;
}

function sameScopeMcpConflictFindings(manifest: McpManifest): StrictAuditFinding[] {
  const findings: StrictAuditFinding[] = [];
  for (const [server, item] of Object.entries(manifest.servers)) {
    if (!item.conflict) continue;
    for (const scope of ["project", "global"] as const) {
      const installations = item.installations.filter((installation) => installation.scope === scope);
      const hashes = new Set(installations.map((installation) => installation.effectiveConfigHash ?? installation.configHash));
      if (hashes.size > 1 && installations[0]) {
        findings.push({ code: "mcp-same-scope-conflict", path: installations[0].path, server, scope });
      }
    }
  }
  return findings;
}

function classifyStrictAudit(
  canonicalExists: boolean,
  canonicalIssues: SkillIssue[],
  skills: Array<{ issues: SkillIssue[] }>,
  mcpIssues: McpAuditIssue[],
  mcpManifest: McpManifest,
  instructions: InstructionsStatus[],
  hookIssues: HookAuditIssue[],
  portableConfigIssues: PortableConfigIssue[],
): StrictAuditSummary {
  const findings: StrictAuditFinding[] = [];
  if (!canonicalExists && !canonicalIssues.some((item) => item.issue === "missing-directory")) {
    findings.push({ code: "canonical-missing", path: canonicalSkills });
  }
  for (const item of canonicalIssues) {
    const code = strictSkillIssueCode(item.issue, true);
    if (code) findings.push({ code, path: item.path });
  }
  for (const skill of skills) {
    for (const item of skill.issues) {
      const code = strictSkillIssueCode(item.issue, false);
      if (code) findings.push({ code, path: item.path });
    }
  }
  for (const item of mcpIssues) {
    findings.push({ code: `mcp-${item.issue}`, path: item.path, server: item.server, field: item.field });
  }
  findings.push(...sameScopeMcpConflictFindings(mcpManifest));
  for (const item of instructions) {
    if (item.status === "missing-claude") findings.push({ code: "instructions-missing-claude", path: item.claude });
    else if (item.status === "wrong-link") findings.push({ code: "instructions-wrong-link", path: item.claude });
    else if (item.status === "conflict") findings.push({ code: "instructions-conflict", path: item.claude });
  }
  for (const item of hookIssues) {
    findings.push({ code: `hook-${item.issue}`, path: item.path, field: item.field, event: item.event, hook: item.hook });
  }
  for (const item of portableConfigIssues) {
    findings.push({ code: `portable-config-${item.issue}`, path: item.path, id: item.id });
  }
  return { actionable: findings.length > 0, findings };
}

function redactMcpAuditIssues(issues: McpAuditIssue[]): McpAuditIssue[] {
  return issues.map((item) => ({ ...item, value: "[redacted]" }));
}

function audit(asJson: boolean, strict = false): void {
  const canonicalIssues = inspectCanonicalSkillDirectory(canonicalSkills);
  const skills = detectedHarnesses().map((harness) => ({
    id: harness.id,
    installed: harness.installed,
    skillDir: harness.skillDir,
    issues: inspectHarnessSkillDirectory(harness),
  }));
  const marketplaceSkills = discoverMarketplaceSkills();
  const mcp = harnesses.flatMap((harness) => harness.mcpFiles.filter(existsSync).map((path) => ({ harness: harness.id, path, servers: mcpInventory(path) })));
  const mcpManifest = scanMcpManifest(mcpSources(), readMcpManifest());
  const mcpIssues = redactMcpAuditIssues(inspectMcpConfigurations(mcpSources()));
  const mcpProvenance = {
    path: mcpManifestPath,
    exists: existsSync(mcpManifestPath),
    servers: Object.keys(mcpManifest.servers).length,
    known: Object.values(mcpManifest.servers).filter((item) => item.source).length,
    unknown: Object.values(mcpManifest.servers).filter((item) => !item.source).length,
    conflicts: Object.entries(mcpManifest.servers).filter(([, item]) => item.conflict).map(([name]) => name),
  };
  const instructions = instructionTargets("all");
  const hookFiles = [join(home, ".claude", "settings.json"), join(home, ".codex", "hooks.json")].filter(pathExists);
  const hookIssues = hookFiles.flatMap((path) => inspectHookConfiguration(path));
  const portableConfigManifest = readPortableConfigManifest();
  const portableConfigIssues = inspectPortableConfigs(portableConfigManifest);
  const portableConfigs = { path: portableConfigManifestPath, exists: existsSync(portableConfigManifestPath), configs: Object.keys(portableConfigManifest.configs).sort(), issues: portableConfigIssues };
  const result = { canonicalSkills, canonicalExists: existsSync(canonicalSkills), canonicalIssues, skills, marketplaceSkills, mcp, mcpProvenance, mcpIssues, instructions, hookIssues, portableConfigs };
  const strictSummary = strict
    ? classifyStrictAudit(result.canonicalExists, canonicalIssues, skills, mcpIssues, mcpManifest, instructions, hookIssues, portableConfigIssues)
    : undefined;
  const output = strict ? { ...result, strict: strictSummary } : result;
  if (asJson) console.log(JSON.stringify(output, null, 2));
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
      } else if (item.issue === "app-owned-harness") {
        console.log(`MCP ownership: ${item.path}: ${item.server} ${item.field}=${item.value} is owned by Codex and cannot be used by ${item.harness}`);
      } else if (item.issue === "app-owned-platform") {
        console.log(`MCP ownership: ${item.path}: ${item.server} ${item.field}=${item.value} is macOS-only and cannot be used on ${platform()}`);
      } else {
        console.log(`MCP portability: ${item.path}: ${item.server} ${item.field}=${item.value} is not portable on ${platform()}; indirect harnesses=${item.indirectHarnesses.join(", ") || "none"}`);
      }
    }
    for (const item of instructions) console.log(`instructions ${item.root}: ${item.status}`);
    for (const item of hookIssues) console.log(`hook portability: ${item.path}: ${item.event}[${item.hook}] ${item.issue}`);
    console.log(`portable configs: ${portableConfigs.exists ? portableConfigs.configs.length : "not initialized"}; issues=${portableConfigIssues.length}`);
    if (strictSummary) console.log(`Strict audit: ${strictSummary.actionable ? `${strictSummary.findings.length} actionable finding(s)` : "clean"}`);
  }
  if (strict) process.exitCode = strictSummary?.actionable ? 1 : 0;
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

const commandFlags: Record<string, { switches: string[]; values: string[] }> = {
  audit: { switches: ["--json", "--strict"], values: [] },
  doctor: { switches: ["--json", "--strict"], values: [] },
  "portable-config register": { switches: ["--apply", "--confirmed", "--replace-source"], values: ["--id", "--source", "--target", "--seed-from", "--format"] },
  "portable-config render": { switches: ["--apply", "--confirmed"], values: ["--id"] },
  init: { switches: ["--apply", "--confirmed"], values: [] },
  instructions: { switches: ["--apply", "--confirmed", "--replace"], values: ["--scope"] },
  add: { switches: ["--apply", "--confirmed", "--full-depth"], values: ["--skill"] },
  remove: { switches: ["--apply", "--confirmed"], values: [] },
  update: { switches: ["--apply", "--confirmed"], values: [] },
  mcp: { switches: ["--apply", "--confirmed", "--direct", "--non-interactive"], values: ["--from", "--target", "--scope", "--server", "--resolve"] },
  "mcp-remove": { switches: ["--apply", "--confirmed"], values: ["--server", "--target", "--scope"] },
};

export function assertKnownFlags(command: string, args: string[]): void {
  const allowed = commandFlags[command];
  if (!allowed) return;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (allowed.values.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
      index++;
    } else if (arg.startsWith("-") && !allowed.switches.includes(arg)) {
      fail(`unknown option for ${command}: ${arg}`);
    }
  }
}

function argumentValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function portableConfigRegister(args: string[]): void {
  const apply = applyRequired(args);
  const id = argumentValue(args, "--id");
  const sourceValue = argumentValue(args, "--source");
  const targetValue = argumentValue(args, "--target");
  const seedValue = argumentValue(args, "--seed-from");
  const format = (argumentValue(args, "--format") ?? "json") as "json" | "text";
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) fail("portable-config register requires --id <lowercase-name>");
  if (!sourceValue || !targetValue) fail("portable-config register requires --source and --target");
  if (!['json', 'text'].includes(format)) fail("--format must be json or text");
  const source = resolvePortablePath(sourceValue);
  const target = resolvePortablePath(targetValue);
  const seed = resolvePortablePath(seedValue ?? targetValue);
  if (source === target) fail("portable source and rendered target must be different paths");
  if (!existsSync(seed) && !existsSync(source)) fail(`portable source seed is missing: ${seed}`);
  const candidate = existsSync(source) && !args.includes("--replace-source") ? source : seed;
  if (format === "json") {
    try { readJson(candidate); } catch { fail(`portable source is not valid JSON: ${candidate}`); }
    const hookIssues = inspectHookConfiguration(candidate, { shared: true });
    if (hookIssues.length) fail(`portable source has ${hookIssues.length} hook portability issue(s)`);
  }
  const manifest = readPortableConfigManifest();
  const entry: PortableConfigEntry = {
    source: homePortablePath(source),
    target: homePortablePath(target),
    format,
    mode: "0600",
  };
  const sourceWillChange = !existsSync(source) || existsSync(seed) && hashFile(source) !== hashFile(seed);
  const plan = {
    action: "portable-config-register",
    apply: false,
    id,
    source: entry.source,
    target: entry.target,
    seed: homePortablePath(seed),
    sourceWillChange,
    targetIgnoreRequired: !targetIsIgnored(target),
    writes: [],
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!apply) return;
  if (existsSync(source) && sourceWillChange && !args.includes("--replace-source")) fail(`portable source exists with different content; review and pass --replace-source: ${source}`);
  const syncedRoot = findSyncthingRoot(target);
  const ignore = syncedRoot ? join(syncedRoot, ".stignore") : undefined;
  const backupRoot = withBackup("portable config registration", [portableConfigManifestPath, source, ...(ignore ? [ignore] : [])], () => {
    if (sourceWillChange) {
      mkdirSync(dirname(source), { recursive: true });
      cpSync(seed, source);
      chmodSync(source, 0o600);
    }
    manifest.configs[id] = entry;
    writeJsonAtomic(portableConfigManifestPath, manifest);
    ensureTargetIgnored(target);
  });
  console.log(`Registered portable config ${id}. Manifest: ${portableConfigManifestPath}. Backup: ${backupRoot}`);
}

function portableConfigRender(args: string[]): void {
  const apply = applyRequired(args);
  const selected = argumentValue(args, "--id");
  const manifest = readPortableConfigManifest();
  const entries = Object.entries(manifest.configs).filter(([id]) => !selected || id === selected);
  if (selected && !entries.length) fail(`portable config is not registered: ${selected}`);
  if (!entries.length) fail("no portable configs are registered");
  const operations = entries.map(([id, entry]) => {
    const source = resolvePortablePath(entry.source);
    const target = resolvePortablePath(entry.target);
    if (!existsSync(source)) fail(`portable source is missing: ${source}`);
    if (entry.format === "json") {
      try { readJson(source); } catch { fail(`portable source is not valid JSON: ${source}`); }
      const issues = inspectHookConfiguration(source, { shared: true });
      if (issues.length) fail(`portable source ${id} has ${issues.length} hook portability issue(s)`);
    }
    return { id, source, target, changed: !existsSync(target) || hashFile(source) !== hashFile(target), ignoreRequired: !targetIsIgnored(target) };
  });
  console.log(JSON.stringify({
    action: "portable-config-render",
    apply: false,
    operations: operations.map((item) => ({ id: item.id, source: homePortablePath(item.source), target: homePortablePath(item.target), changed: item.changed, ignoreRequired: item.ignoreRequired })),
    writes: [],
  }, null, 2));
  if (!apply) return;
  const affected = operations.flatMap((item) => {
    const root = findSyncthingRoot(item.target);
    return [item.target, ...(root ? [join(root, ".stignore")] : [])];
  });
  const backupRoot = withBackup("portable config render", affected, () => {
    for (const item of operations) {
      ensureTargetIgnored(item.target);
      if (item.changed) {
        mkdirSync(dirname(item.target), { recursive: true });
        cpSync(item.source, item.target);
      }
      chmodSync(item.target, 0o600);
    }
    const remaining = inspectPortableConfigs({ ...manifest, configs: Object.fromEntries(entries) });
    if (remaining.length) throw new Error(`render left ${remaining.length} portable config issue(s)`);
  });
  console.log(`Rendered ${operations.length} portable config(s). Backup: ${backupRoot}`);
}

function portableConfigCommand(args: string[]): void {
  const [action, ...rest] = args;
  if (action === "register") return portableConfigRegister(rest);
  if (action === "render") return portableConfigRender(rest);
  fail("portable-config requires register or render");
}

function doctor(asJson: boolean, strict: boolean): void {
  const hookFiles = [join(home, ".claude", "settings.json"), join(home, ".codex", "hooks.json")].filter(pathExists);
  const hookIssues = hookFiles.flatMap((path) => inspectHookConfiguration(path));
  const manifest = readPortableConfigManifest();
  const portableConfigs = inspectPortableConfigs(manifest);
  const report = {
    version: 1,
    host: hostname(),
    platform: platform(),
    arch: arch(),
    harnesses: detectedHarnesses().map((item) => ({ id: item.id, installed: item.installed })),
    hooks: { files: hookFiles.map((path) => homePortablePath(path)), issues: hookIssues },
    portableConfigs: { manifest: homePortablePath(portableConfigManifestPath), registered: Object.keys(manifest.configs).sort(), issues: portableConfigs },
    actionable: hookIssues.length + portableConfigs.length > 0,
  };
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.host}: ${report.platform}/${report.arch}`);
    for (const item of report.harnesses) console.log(`${item.id}: ${item.installed ? "installed" : "config-only"}`);
    console.log(`hook issues: ${hookIssues.length}`);
    console.log(`portable config issues: ${portableConfigs.length}`);
  }
  if (strict) process.exitCode = report.actionable ? 1 : 0;
}

function addSkill(args: string[]): void {
  const apply = applyRequired(args);
  const sourceArgs = normalizeAddInput(args.filter((arg) => arg !== "--apply" && arg !== "--confirmed"));
  const agents = detectedHarnesses().filter((item) => item.installed && item.npxAgent).map((item) => item.npxAgent!);
  const command = ["npx", "--yes", "skills", "add", ...sourceArgs, "-g", "-y", "--agent", ...agents];
  console.log(`Plan: ${command.join(" ")}`);
  if (!apply) return;
  const before = currentSkillManifest();
  const backupRoot = withBackup("add", skillMutationPaths(), () => {
    run(command);
    const after = scanSkillManifest(canonicalSkills, globalSkillLocks(), before);
    const selectedIndex = sourceArgs.indexOf("--skill");
    const selected = selectedIndex >= 0 ? new Set(sourceArgs.slice(selectedIndex + 1).filter((item) => !item.startsWith("--"))) : null;
    const affected = Object.entries(after.skills)
      .filter(([name, item]) => selected?.has(name) || before.skills[name]?.contentHash !== item.contentHash || !before.skills[name])
      .map(([name]) => name);
    assertStandaloneSkills(affected);
    for (const name of affected) {
      const item = after.skills[name];
      if (item.source) {
        item.provenance = "install";
        item.installSource = sourceArgs[0];
        if (sourceArgs.includes("--full-depth")) item.fullDepth = true;
      }
    }
    writeJsonAtomic(skillManifestPath, after);
  });
  console.log(`Applied. Provenance: ${skillManifestPath}. Backup: ${backupRoot}`);
}

function skillMutationPaths(): string[] {
  return [...globalSkillLocks(), canonicalSkills, ...harnesses.map((item) => item.skillDir), skillManifestPath];
}

function npxLockOwns(name: string): boolean {
  for (const path of globalSkillLocks()) {
    if (!existsSync(path)) continue;
    try {
      const lock = readJson(path);
      const skills = lock?.skills && typeof lock.skills === "object" ? lock.skills : lock;
      if (skills && typeof skills === "object" && Object.hasOwn(skills, name)) return true;
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
  const backupRoot = withBackup("remove", [...targets, ...globalSkillLocks(), skillManifestPath], () => {
    if (npxLockOwns(name)) run(["npx", "--yes", "skills", "remove", name, "-g", "-y"]);
    for (const target of targets) removeExistingPath(target);
    const manifest = readSkillManifest();
    delete manifest.skills[name];
    writeJsonAtomic(skillManifestPath, manifest);
  });
  console.log(`Removed ${name}. Backup: ${backupRoot}`);
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
  console.log(`Plan: reinstall ${tracked.length} tracked skill(s) from recorded sources; upstream changes are not compared before apply`);
  for (const name of tracked) console.log(`  ${name} from ${skillInstallSource(manifest.skills[name])} (current ${manifest.skills[name].version})`);
  if (unknown.length) console.log(`Skip (unknown source): ${unknown.join(", ")}`);
  if (cleanNames.length && unknown.length) fail(`cannot update skills with unknown source: ${unknown.join(", ")}`);
  if (!apply) return;
  const agents = detectedHarnesses().filter((item) => item.installed && item.npxAgent).map((item) => item.npxAgent!);
  const backupRoot = withBackup("update", skillMutationPaths(), () => {
    for (const name of tracked) {
      const item = manifest.skills[name];
      run(["npx", "--yes", "skills", "add", skillInstallSource(item)!, "--skill", name, ...(item.fullDepth ? ["--full-depth"] : []), "-g", "-y", "--agent", ...agents]);
    }
    const refreshed = scanSkillManifest(canonicalSkills, globalSkillLocks(), manifest);
    assertStandaloneSkills(tracked);
    for (const name of tracked) refreshed.skills[name].provenance = "install";
    writeJsonAtomic(skillManifestPath, refreshed);
  });
  console.log(`Applied ${tracked.length} update(s). Provenance: ${skillManifestPath}. Backup: ${backupRoot}`);
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
  const backupRoot = withBackup("init", [skillManifestPath, mcpManifestPath], () => {
    writeJsonAtomic(skillManifestPath, skillManifest);
    writeJsonAtomic(mcpManifestPath, mcpManifest);
  });
  console.log(`Initialized ${skillManifestPath} and ${mcpManifestPath}. Backup: ${backupRoot}`);
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
  const match = header.match(/^mcp_servers\.(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))(?:\.(.+))?$/);
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

type TomlSection = { header?: string; arrayTable: boolean; statements: string[] };

function tomlLineState(line: string, state: { depth: number; triple?: string }): { depth: number; triple?: string } {
  let { depth, triple } = state;
  let index = 0;
  while (index < line.length) {
    if (triple) {
      const end = line.indexOf(triple, index);
      if (end < 0) return { depth, triple };
      index = end + 3;
      triple = undefined;
      continue;
    }
    const char = line[index];
    if (char === "#") break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      triple = line.slice(index, index + 3);
      index += 3;
    } else if (char === '"') {
      index++;
      while (index < line.length && line[index] !== '"') index += line[index] === "\\" ? 2 : 1;
      index++;
    } else if (char === "'") {
      const end = line.indexOf("'", index + 1);
      index = end < 0 ? line.length : end + 1;
    } else {
      if (char === "[" || char === "{") depth++;
      if (char === "]" || char === "}") depth--;
      index++;
    }
  }
  return { depth, triple };
}

function tomlStatements(text: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let state: { depth: number; triple?: string } = { depth: 0 };
  for (const line of text.split("\n")) {
    current.push(line);
    state = tomlLineState(line, state);
    if (state.depth <= 0 && !state.triple) {
      statements.push(current.join("\n"));
      current = [];
      state = { depth: 0 };
    }
  }
  if (current.length) statements.push(current.join("\n"));
  return statements;
}

function tomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [{ arrayTable: false, statements: [] }];
  for (const statement of tomlStatements(text.trimEnd())) {
    const header = statement.includes("\n") ? undefined : statement.trim().match(/^(\[\[?)\s*([^\[\]]+?)\s*\]\]?\s*(?:#.*)?$/);
    if (header) sections.push({ header: header[2], arrayTable: header[1] === "[[", statements: [statement] });
    else sections.at(-1)!.statements.push(statement);
  }
  return sections;
}

function tomlSectionText(section: TomlSection): string {
  return section.statements.join("\n").trim();
}

function codexSectionServer(section: TomlSection): { server: string; field?: string } | undefined {
  return section.header && !section.arrayTable ? codexSection(section.header) : undefined;
}

function updateCodexServer(text: string, name: string, server: McpServer): string {
  const kept: string[] = [];
  const unknownRoot: string[] = [];
  for (const section of tomlSections(text)) {
    const parsed = codexSectionServer(section);
    if (parsed?.server !== name) {
      if (tomlSectionText(section)) kept.push(tomlSectionText(section));
      continue;
    }
    if (parsed.field === "env" || parsed.field === "http_headers") continue;
    if (!parsed.field) {
      unknownRoot.push(...section.statements.slice(1).filter((statement) => statement.trim() && !/^\s*(?:command|args|cwd|url|enabled|env|http_headers)\s*=/.test(statement)));
      continue;
    }
    kept.push(tomlSectionText(section));
  }
  kept.push(codexServerBlock(name, server, unknownRoot));
  return `${kept.filter(Boolean).join("\n\n")}\n`;
}

function renderCodex(path: string, servers: Record<string, McpServer>): void {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [name, server] of Object.entries(servers)) text = updateCodexServer(text, name, server);
  writeTextAtomic(path, text);
}

function removeCodexServers(path: string, names: Set<string>): void {
  const kept = tomlSections(readFileSync(path, "utf8")).filter((section) => {
    const parsed = codexSectionServer(section);
    return !parsed || !names.has(parsed.server);
  });
  writeTextAtomic(path, `${kept.map(tomlSectionText).filter(Boolean).join("\n\n")}\n`);
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

function parseDirectTarget(harness: string, path: string): any {
  const text = readFileSync(path, "utf8");
  if (harness === "codex") return Bun.TOML.parse(text);
  if (harness === "hermes" || harness === "goose") return Bun.YAML.parse(text) ?? {};
  return path.endsWith(".jsonc") ? Bun.JSONC.parse(text) : JSON.parse(text);
}

function directServerContainer(harness: string, document: any): Record<string, unknown> | undefined {
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (harness === "codex" || harness === "hermes") return object(document?.mcp_servers);
  if (harness === "goose") return object(document?.extensions);
  if (harness === "opencode") return object(document?.mcp?.servers) ?? object(document?.mcp);
  return object(document?.mcpServers) ?? object(document?.mcp?.servers) ?? object(document?.mcp);
}

function withoutServers(harness: string, document: any, names: string[]): string {
  const copy = structuredClone(document ?? {});
  const container = directServerContainer(harness, copy);
  if (container) for (const name of names) delete container[name];
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(prune);
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, prune(item)] as const)
      .filter(([, item]) => !(item && typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length))
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
  };
  return JSON.stringify(prune(copy));
}

function verifiedDirectWrite(harness: string, path: string, names: string[], present: boolean, write: () => void): void {
  const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const before = original === undefined ? undefined : parseDirectTarget(harness, path);
  write();
  try {
    let after: any;
    try {
      after = parseDirectTarget(harness, path);
    } catch (error) {
      throw new Error(`rendered ${harness} config is not valid: ${(error as Error).message}`);
    }
    const container = directServerContainer(harness, after) ?? {};
    const wrong = names.filter((name) => (name in container) !== present);
    if (wrong.length) throw new Error(`rendered ${harness} config has unexpected server state: ${wrong.join(", ")}`);
    if (before !== undefined && withoutServers(harness, before, names) !== withoutServers(harness, after, names)) {
      throw new Error(`rendered ${harness} config changed settings outside the selected servers`);
    }
  } catch (error) {
    if (original === undefined) rmSync(writeDestination(path), { force: true });
    else writeTextAtomic(path, original);
    throw new Error(`${(error as Error).message}; ${path} left unchanged`);
  }
}

export function renderDirectTarget(harness: string, path: string, servers: Record<string, McpServer>): void {
  const names = Object.keys(servers);
  if (harness === "codex") return verifiedDirectWrite(harness, path, names, true, () => renderCodex(path, servers));
  if (harness === "pi" || harness === "catalog") return verifiedDirectWrite(harness, path, names, true, () => renderPi(path, servers));
  if (harness === "opencode") return verifiedDirectWrite(harness, path, names, true, () => renderOpenCode(path, servers));
  if (harness === "hermes" || harness === "goose") return verifiedDirectWrite(harness, path, names, true, () => renderYamlTarget(path, harness, servers));
  fail(`no direct MCP renderer for ${harness}`);
}

export function removeDirectMcpServers(harness: string, path: string, serverNames: string[]): void {
  if (!existsSync(path)) return;
  verifiedDirectWrite(harness, path, serverNames, false, () => removeDirectMcpServersUnchecked(harness, path, serverNames));
}

function removeDirectMcpServersUnchecked(harness: string, path: string, serverNames: string[]): void {
  const names = new Set(serverNames);
  if (harness === "codex") return removeCodexServers(path, names);
  if (harness === "pi" || harness === "catalog") {
    const json: any = readJson(path);
    const target = json.mcpServers && typeof json.mcpServers === "object"
      ? json.mcpServers
      : json.mcp?.servers && typeof json.mcp.servers === "object"
        ? json.mcp.servers
        : json.mcp && typeof json.mcp === "object"
          ? json.mcp
          : undefined;
    if (target) for (const name of names) delete target[name];
    return writeJsonAtomic(path, json);
  }
  if (harness === "opencode") {
    const json: any = path.endsWith(".jsonc") ? Bun.JSONC.parse(readFileSync(path, "utf8")) : readJson(path);
    const target = json.mcp?.servers && typeof json.mcp.servers === "object" ? json.mcp.servers : json.mcp;
    if (target && typeof target === "object") for (const name of names) delete target[name];
    return writeJsonAtomic(path, json);
  }
  if (harness === "hermes" || harness === "goose") {
    const yaml: any = Bun.YAML.parse(readFileSync(path, "utf8"));
    const target = harness === "hermes" ? yaml.mcp_servers : yaml.extensions;
    if (target && typeof target === "object") for (const name of names) delete target[name];
    return writeTextAtomic(path, Bun.YAML.stringify(yaml));
  }
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
      const reference = piWrapperHarnesses.has(source.harness) ? piServerReference(rawServer) : undefined;
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
  if (!piWrapperHarnesses.has(harness)) return servers;
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

export function mcpNativeCliRemoveCommand(
  harness: "claude" | "grok" | "gemini",
  scope: "project" | "global",
  name: string,
): string[] {
  return [harness, "mcp", "remove", "--scope", scope === "global" ? "user" : "project", name];
}

export function buildMcpRemovalPlan(
  serverNames: string[],
  targets: McpTargetBinding[],
  scope: "project" | "global",
): McpRemovalPlan {
  const operations = serverNames.map((server) => ({
    server,
    targets: targets
      .filter((target) => Boolean(target.servers[server]))
      .map((target) => ({ binding: bindingId(target), path: target.path, renderer: rendererFor(target.harness) })),
    preserve: ["unrelated servers", "unknown native fields"],
  })).filter((operation) => operation.targets.length > 0);
  return {
    version: 1,
    action: "remove",
    apply: false,
    status: "ready-for-review",
    scope,
    servers: serverNames,
    operations,
    missing: serverNames.flatMap((name) => targets.filter((target) => !target.servers[name]).map((target) => `${bindingId(target)}:${name}`)),
    writes: [],
    requiresSeparateApplyConsent: operations.length > 0,
    exitCode: 0,
  };
}

export function buildMcpSyncPlan(
  source: McpTargetBinding,
  targets: McpTargetBinding[],
  resolutions: Record<string, McpResolution> = {},
  mode: "interactive" | "non-interactive" = "non-interactive",
  currentPlatform: NodeJS.Platform = platform(),
): { plan: McpSyncPlan; definitions: Record<string, McpServer> } {
  const identical: string[] = [], missing: string[] = [], conflicts: string[] = [], unrelated: string[] = [];
  const operations: McpSyncPlan["operations"] = [], unresolvedConflicts: McpSyncPlan["unresolvedConflicts"] = [];
  const skippedConflicts: string[] = [], skippedIncompatible: McpSyncPlan["skippedIncompatible"] = [], definitions: Record<string, McpServer> = {};
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

    const compatibleTargets = targets.filter((target) => {
      const targetServer = target.servers[name];
      const preserveTarget = targetServer
        && classifyAppOwnedMcp(targetServer)
        && !sameMcpServer(chosen, targetServer);
      const reasons = [...new Set([
        ...appOwnedMcpCompatibility(chosen, target.harness, currentPlatform),
        ...appOwnedMcpCompatibility(targetServer ?? {}, target.harness, currentPlatform),
        ...(preserveTarget ? ["preserve-app-owned" as const] : []),
      ])];
      if (!reasons.length) return true;
      skippedIncompatible.push({ server: name, binding: bindingId(target), reasons });
      return false;
    });
    const changedTargets = compatibleTargets.filter((target) => {
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
    skippedIncompatible,
    writes: [],
    requiresSeparateApplyConsent: operations.length > 0,
    exitCode: blocked ? 2 : 0,
  };
  return { plan, definitions };
}

const supportedMcpTargets = ["codex", "claude", "pi", "grok", "opencode", "gemini", "hermes", "goose", "catalog"];
const directTargets = new Set(["codex", "pi", "opencode", "hermes", "goose", "catalog"]);

function resolveMcpTargets(requested: string[]): string[] {
  const detected = detectedHarnesses();
  const targetNames = requested.length
    ? [...new Set(requested)]
    : detected.filter((item) => item.installed && supportedMcpTargets.includes(item.id)).map((item) => item.id);
  for (const target of targetNames) {
    if (!supportedMcpTargets.includes(target)) fail(`unsupported MCP target: ${target}`);
    if (!directTargets.has(target) && !detected.some((item) => item.id === target && item.installed)) fail(`MCP target not installed: ${target}`);
  }
  return targetNames;
}

function mcpSync(args: string[]): void {
  const apply = applyRequired(args);
  const valueAfter = (flag: string, fallback: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
  const valuesAfter = (flag: string) => args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]] : []);
  const from = valueAfter("--from", "auto");
  const scope = valueAfter("--scope", "auto");
  if (!["auto", "project", "global"].includes(scope)) fail("--scope must be auto, project, or global");
  const source = sourceForMcp(from, scope);
  const effectiveScope = scope === "auto" ? source.scope : scope;
  const requestedServer = valueAfter("--server", "");
  const allServers = effectiveMcpServers(source.harness, normalizeMcpFile(source.path));
  const servers = requestedServer ? Object.fromEntries(Object.entries(allServers).filter(([name]) => name === requestedServer)) : allServers;
  if (requestedServer && !Object.keys(servers).length) fail(`MCP server not found in source: ${requestedServer}`);
  const targetNames = resolveMcpTargets(valuesAfter("--target"));
  const unsupported = targetNames.filter((target) => !mcpTargetPath(target, effectiveScope)).map((target) => `${target}:${effectiveScope}`);
  const replaceWrappers = args.includes("--direct");
  const targets: McpTargetBinding[] = targetNames.flatMap((harness) => {
    const path = mcpTargetPath(harness, effectiveScope as "project" | "global");
    if (!path) return [];
    const raw = existsSync(path) ? normalizeMcpFile(path) : {};
    const effective = effectiveMcpServers(harness, raw);
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
  const backupRoot = withBackup("MCP sync", [...targetPaths, mcpManifestPath], () => {
    for (const harness of directTargets) {
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
        run(mcpNativeCliCommand(target.harness as "claude" | "grok" | "gemini", effectiveScope as "project" | "global", operation.server, server), { cwd: projectRoot() });
        if (existsSync(target.path)) chmodSync(target.path, 0o600);
      }
    }
    writeJsonAtomic(mcpManifestPath, scanMcpManifest(mcpSources(), readMcpManifest()));
  });
  console.log(`Applied ${built.plan.operations.reduce((count, operation) => count + operation.targets.length, 0)} MCP binding(s). Provenance: ${mcpManifestPath}. Backup: ${backupRoot}`);
}

function mcpRemove(args: string[]): void {
  const apply = applyRequired(args);
  const valuesAfter = (flag: string) => args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]] : []);
  const scopeIndex = args.indexOf("--scope");
  const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : "";
  if (scope !== "project" && scope !== "global") fail("mcp-remove requires --scope project|global");
  const serverNames = [...new Set(valuesAfter("--server"))];
  if (!serverNames.length) fail("mcp-remove requires at least one --server <name>");
  if (serverNames.some((name) => name.startsWith("-") || /[\0\r\n]/.test(name))) fail("invalid MCP server name");

  const targetNames = resolveMcpTargets(valuesAfter("--target"));
  const unsupported = targetNames.filter((target) => !mcpTargetPath(target, scope)).map((target) => `${target}:${scope}`);
  const targets: McpTargetBinding[] = targetNames.flatMap((harness) => {
    const path = mcpTargetPath(harness, scope);
    if (!path) return [];
    return [{ harness, path, scope, servers: existsSync(path) ? normalizeMcpFile(path) : {} }];
  });
  const plan = buildMcpRemovalPlan(serverNames, targets, scope);
  console.log(`Remove: ${serverNames.join(", ")}; scope=${scope}`);
  console.log(`Missing: ${plan.missing.join(", ") || "none"}`);
  console.log(`Unsupported scope: ${unsupported.join(", ") || "none"}`);
  console.log(JSON.stringify({ ...plan, apply }, null, 2));
  if (!apply) return;
  if (unsupported.length) fail(`target does not support ${scope} MCP scope; no config was written: ${unsupported.join(", ")}`);
  if (!plan.operations.length) return;

  const targetPaths = [...new Set(plan.operations.flatMap((operation) => operation.targets.map((target) => target.path)))];
  const count = plan.operations.reduce((total, operation) => total + operation.targets.length, 0);
  const backupRoot = withBackup("MCP removal", [...targetPaths, mcpManifestPath], () => {
    for (const target of targets) {
      const selected = plan.operations.filter((operation) => operation.targets.some((item) => item.binding === bindingId(target))).map((operation) => operation.server);
      if (!selected.length) continue;
      if (directTargets.has(target.harness)) removeDirectMcpServers(target.harness, target.path, selected);
      else for (const name of selected) {
        run(mcpNativeCliRemoveCommand(target.harness as "claude" | "grok" | "gemini", scope, name), { cwd: projectRoot() });
        if (existsSync(target.path)) chmodSync(target.path, 0o600);
      }
    }
    writeJsonAtomic(mcpManifestPath, scanMcpManifest(mcpSources(), readMcpManifest()));
  });
  console.log(`Removed ${count} MCP binding(s). Provenance: ${mcpManifestPath}. Backup: ${backupRoot}`);
}

function usage(): void {
  console.log(`harness-sync [audit|doctor|portable-config|init|instructions|add|remove|update|mcp|mcp-remove]

Commands:
  audit [--strict] [--json]
  doctor [--strict] [--json]
  portable-config register --id <name> --source <portable-file> --target <rendered-file>
      [--seed-from <existing-file>] [--format json|text] [--replace-source]
  portable-config render [--id <name>]
  init
  instructions [--scope project|user|all] [--replace]
  add <source|npx skills add ...> [--skill <name>...] [--full-depth]
  remove <skill>
  update [skill ...]
  mcp [--from auto|catalog|<harness>|<path>] [--target <harness>]...
      [--scope auto|project|global] [--server <name>]
      [--resolve <server>=source|target:<harness>|merge|skip]...
      [--direct] [--non-interactive]
  mcp-remove --server <name>... --target <harness>... --scope project|global

Harnesses: ${harnesses.map((item) => item.id).join(", ")}
MCP sync also accepts catalog as a target. Repeat --server/--target flags for removal.
Recommended: audit
Strict audit exits 1 for actionable findings; default audit reports without failing.
Audit checks the complete inventory, including user state; it has no scope filter.
Run a mutation command without --apply for a plan. Writes require --apply --confirmed.`);
}

export function main(argv = process.argv.slice(2)): void {
  const [command, ...args] = argv;
  try {
    if (!command || argv.includes("--help") || argv.includes("-h")) return usage();
    const flagScope = command === "portable-config" ? `${command} ${args[0] ?? ""}` : command;
    const addSourceIsCommand = command === "add" && (args[0] === "npx" || args[0]?.includes(" "));
    if (!addSourceIsCommand) assertKnownFlags(flagScope, command === "portable-config" ? args.slice(1) : args);
    if (command === "audit") return audit(args.includes("--json"), args.includes("--strict"));
    if (command === "doctor") return doctor(args.includes("--json"), args.includes("--strict"));
    if (command === "portable-config") return portableConfigCommand(args);
    if (command === "init") return initState(args);
    if (command === "instructions") return syncInstructions(args);
    if (command === "add") return addSkill(args);
    if (command === "remove") return removeSkill(args[0] ?? "", args.slice(1));
    if (command === "update") return updateSkills(args, args);
    if (command === "mcp") return mcpSync(args);
    if (command === "mcp-remove") return mcpRemove(args);
    usage();
    fail(`unknown command: ${command}`);
  } catch (error) {
    fail((error as Error).message);
  }
}

if (import.meta.main) main();
