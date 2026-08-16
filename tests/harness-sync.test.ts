import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMarketplaceSkills, inferMcpScope, inferMcpUpstream, inspectInstructions, inspectSkillDirectory, normalizeAddInput, normalizeMcpFile, normalizeMcpJson, removalTargets, removeExistingPath, renderDirectTarget, sameMcpServer, scanMcpManifest, scanSkillManifest, validSkillName } from "../scripts/harness-sync";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("skill sources", () => {
  test("resolves a skills.sh page", () => {
    expect(normalizeAddInput(["https://skills.sh/mattpocock/skills/writing-for-agents"])).toEqual([
      "mattpocock/skills",
      "--skill",
      "writing-for-agents",
    ]);
  });

  test("accepts only npx skills add commands", () => {
    expect(normalizeAddInput(["npx skills add mattpocock/skills --skill tdd"])).toEqual([
      "mattpocock/skills",
      "--skill",
      "tdd",
    ]);
    expect(() => normalizeAddInput(["npx evil-package add thing"])).toThrow();
  });
});

describe("skill provenance", () => {
  test("initializes known sources from the npx lock and keeps unknown skills explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const canonical = join(root, "skills");
    mkdirSync(join(canonical, "known"), { recursive: true });
    mkdirSync(join(canonical, "manual"), { recursive: true });
    writeFileSync(join(canonical, "known", "SKILL.md"), "---\nname: known\n---\nknown");
    writeFileSync(join(canonical, "manual", "SKILL.md"), "---\nname: manual\n---\nmanual");
    const lock = join(root, "lock.json");
    writeFileSync(lock, JSON.stringify({ skills: { known: { source: "owner/repo", sourceType: "github", sourceUrl: "https://github.com/owner/repo.git", skillPath: "skills/known/SKILL.md", skillFolderHash: "version-1", installedAt: "2026-01-01", updatedAt: "2026-01-02" } } }));
    const manifest = scanSkillManifest(canonical, [lock], { version: 1, skills: {} }, "2026-02-01");
    expect(manifest.skills.known.source).toBe("owner/repo");
    expect(manifest.skills.known.version).toBe("version-1");
    expect(manifest.skills.known.provenance).toBe("lock-import");
    expect(manifest.skills.manual.source).toBeNull();
    expect(manifest.skills.manual.provenance).toBe("scan");
  });

  test("preserves provenance and versions while content is unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const canonical = join(root, "skills");
    mkdirSync(join(canonical, "demo"), { recursive: true });
    writeFileSync(join(canonical, "demo", "SKILL.md"), "---\nname: demo\n---\ndemo");
    const first = scanSkillManifest(canonical, [], { version: 1, skills: {} }, "first");
    first.skills.demo.source = "owner/repo";
    first.skills.demo.provenance = "install";
    first.skills.demo.fullDepth = true;
    const second = scanSkillManifest(canonical, [], first, "second");
    expect(second.skills.demo.source).toBe("owner/repo");
    expect(second.skills.demo.version).toBe(first.skills.demo.version);
    expect(second.skills.demo.updatedAt).toBe("first");
    expect(second.skills.demo.provenance).toBe("install");
    expect(second.skills.demo.fullDepth).toBeTrue();
  });
});

describe("skill names", () => {
  test("rejects traversal and uppercase", () => {
    expect(validSkillName("harness-sync")).toBeTrue();
    expect(validSkillName("../escape")).toBeFalse();
    expect(validSkillName("Harness-Sync")).toBeFalse();
  });
});

describe("skill removal", () => {
  test("finds manually installed skills without ownership metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const skill = join(root, "manual-skill");
    writeFileSync(skill, "manual");
    expect(removalTargets("manual-skill", [root])).toEqual([skill]);
  });

  test("removes a broken skill symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const skill = join(root, "broken-skill");
    symlinkSync("missing-target", skill);
    expect(removalTargets("broken-skill", [root])).toEqual([skill]);
    removeExistingPath(skill);
    expect(() => lstatSync(skill)).toThrow();
  });
});

describe("skill audit", () => {
  test("finds wrong links and drifted copies", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const canonical = join(root, "canonical");
    const target = join(root, "target");
    mkdirSync(join(canonical, "demo"), { recursive: true });
    mkdirSync(join(target, "demo"), { recursive: true });
    writeFileSync(join(canonical, "demo", "SKILL.md"), "---\nname: demo\n---\ncanonical");
    writeFileSync(join(target, "demo", "SKILL.md"), "---\nname: demo\n---\nchanged");
    symlinkSync("missing", join(target, "broken"));
    expect(inspectSkillDirectory(target, canonical).map((item) => item.issue)).toEqual(["broken-skill-link", "copy-drift"]);
  });

  test("deduplicates marketplace skills and marks canonical conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const canonical = join(root, "canonical");
    const claude = join(root, "claude", "market", "plugin", "1", "skills", "demo");
    const codex = join(root, "codex", "market", "plugin", "1", "skills", "demo");
    mkdirSync(join(canonical, "demo"), { recursive: true });
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(canonical, "demo", "SKILL.md"), "canonical");
    writeFileSync(join(claude, "SKILL.md"), "marketplace");
    writeFileSync(join(codex, "SKILL.md"), "marketplace");
    const found = discoverMarketplaceSkills([{ harness: "claude", path: join(root, "claude") }, { harness: "codex", path: join(root, "codex") }], canonical);
    expect(found).toHaveLength(1);
    expect(found[0].status).toBe("conflict");
    expect(found[0].sources).toHaveLength(2);
  });
});

describe("MCP normalization", () => {
  test("reads Claude shape", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const path = join(root, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["demo"] } } }));
    expect(normalizeMcpJson(path).demo).toEqual({ command: "npx", args: ["demo"] });
  });

  test("reads OpenCode shape", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const path = join(root, "opencode.json");
    writeFileSync(path, JSON.stringify({ mcp: { demo: { type: "local", command: ["npx", "demo"], environment: { TOKEN: "x" } } } }));
    expect(normalizeMcpJson(path).demo).toEqual({
      type: "stdio",
      command: "npx",
      args: ["demo"],
      env: { TOKEN: "x" },
      enabled: true,
    });
  });

  test("reads Codex and Grok TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const path = join(root, "config.toml");
    writeFileSync(path, '[mcp_servers.demo]\ncommand = "npx"\nargs = ["demo"]\n[mcp_servers.demo.env]\nTOKEN = "secret"\n');
    expect(normalizeMcpFile(path).demo).toEqual({ command: "npx", args: ["demo"], env: { TOKEN: "secret" } });
  });

  test("reads Hermes and Goose YAML", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const path = join(root, "config.yaml");
    writeFileSync(path, "extensions:\n  demo:\n    type: stdio\n    cmd: npx\n    args: [demo]\n    enabled: true\n");
    expect(normalizeMcpFile(path).demo?.command).toBe("npx");
    expect(normalizeMcpFile(path).demo?.args).toEqual(["demo"]);
  });

  test("compares normalized definitions instead of names", () => {
    expect(sameMcpServer({ command: "npx", args: ["demo"], env: { B: "2", A: "1" } }, { type: "stdio", command: "npx", args: ["demo"], env: { A: "1", B: "2" }, enabled: true })).toBeTrue();
    expect(sameMcpServer({ url: "https://example.test", headers: { Authorization: "x" } }, { type: "http", url: "https://example.test", headers: { authorization: "x" } })).toBeTrue();
    expect(sameMcpServer({ command: "npx", args: ["one"] }, { command: "npx", args: ["two"] })).toBeFalse();
  });

  test("infers explicit file scope from project containment", () => {
    expect(inferMcpScope("/work/repo/.mcp.json", "/work/repo")).toBe("project");
    expect(inferMcpScope("/home/user/.mcp.json", "/work/repo")).toBe("global");
  });

  test("renders Codex, OpenCode, Hermes, and Goose targets", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const server = { demo: { command: "npx", args: ["demo"], env: { TOKEN: "value" } } };
    for (const [harness, filename] of [["codex", "config.toml"], ["opencode", "opencode.json"], ["hermes", "hermes.yaml"], ["goose", "goose.yaml"]]) {
      const path = join(root, filename);
      renderDirectTarget(harness, path, server);
      expect(normalizeMcpFile(path).demo?.command).toBe("npx");
      expect(normalizeMcpFile(path).demo?.args).toEqual(["demo"]);
    }
  });
});

describe("MCP provenance", () => {
  test("infers known package and remote upstreams", () => {
    expect(inferMcpUpstream({ command: "npx", args: ["-y", "@vendor/demo@latest"] })).toEqual({ source: "@vendor/demo@latest", sourceType: "npm", provenance: "inferred" });
    expect(inferMcpUpstream({ command: "uvx", args: ["demo-mcp"] }).sourceType).toBe("pypi");
    expect(inferMcpUpstream({ url: "https://mcp.example.test" }).sourceType).toBe("url");
    expect(inferMcpUpstream({ command: "/opt/internal-mcp" }).source).toBeNull();
  });

  test("registers locations without storing secret values and flags semantic conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const claude = join(root, ".mcp.json");
    const codex = join(root, "config.toml");
    writeFileSync(claude, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["demo"], env: { TOKEN: "first-secret" } } } }));
    writeFileSync(codex, '[mcp_servers.demo]\ncommand = "npx"\nargs = ["demo"]\n[mcp_servers.demo.env]\nTOKEN = "second-secret"\n');
    const manifest = scanMcpManifest([
      { harness: "claude", path: claude, scope: "project" },
      { harness: "codex", path: codex, scope: "global" },
    ], { version: 1, servers: {} }, "now");
    expect(manifest.servers.demo.source).toBe("demo");
    expect(manifest.servers.demo.sourceType).toBe("npm");
    expect(manifest.servers.demo.conflict).toBeTrue();
    expect(manifest.servers.demo.configHash).toBeNull();
    expect(JSON.stringify(manifest)).not.toContain("first-secret");
    expect(JSON.stringify(manifest)).not.toContain("second-secret");
  });
});

describe("instruction files", () => {
  test("AGENTS.md is canonical for CLAUDE.md", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
    expect(inspectInstructions(root).status).toBe("missing-claude");
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    expect(inspectInstructions(root).status).toBe("correct-link");
  });

  test("reports a real CLAUDE.md as conflict", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
    writeFileSync(join(root, "CLAUDE.md"), "# Claude\n");
    expect(inspectInstructions(root).status).toBe("conflict");
  });
});
