import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpSyncPlan, discoverMarketplaceSkills, harnesses, inferMcpScope, inferMcpUpstream, inspectInstructions, inspectMcpConfigurations, inspectSkillDirectory, mcpNativeCliCommand, normalizeAddInput, normalizeMcpFile, normalizeMcpJson, piServerReference, removalTargets, removeExistingPath, renderDirectTarget, sameMcpServer, scanMcpManifest, scanSkillManifest, sourceForMcp, validSkillName } from "../scripts/harness-sync";

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
  test("registers and inventories the global Pi MCP config", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const path = join(root, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["demo"] } } }));
    const manifest = scanMcpManifest([{ harness: "pi", path, scope: "global" }], { version: 1, servers: {} }, "now");
    expect(harnesses.find((item) => item.id === "pi")?.mcpFiles[0]).toEndWith("/.pi/mcp/mcp.json");
    expect(manifest.servers.demo.installations[0]).toMatchObject({ harness: "pi", path, scope: "global" });
  });

  test("selects Pi as an explicit MCP source", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const path = join(root, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["demo"] } } }));
    expect(sourceForMcp("pi", "global", [{ harness: "pi", path, scope: "global" }])).toEqual({ harness: "pi", path, scope: "global" });
  });

  test("uses the local catalog only as an explicit source", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const catalog = join(root, "mcp.json");
    const native = join(root, ".mcp.json");
    writeFileSync(catalog, JSON.stringify({ mcpServers: { catalog: { command: "catalog" } } }));
    writeFileSync(native, JSON.stringify({ mcpServers: { native: { command: "native" } } }));
    const sources = [
      { harness: "catalog", path: catalog, scope: "project" as const },
      { harness: "claude", path: native, scope: "project" as const },
    ];
    expect(sourceForMcp("auto", "project", sources).harness).toBe("claude");
    expect(sourceForMcp("catalog", "project", sources).path).toBe(catalog);
  });

  test("accepts a bare relative MCP source path", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "demo" } } }));
    expect(sourceForMcp("mcp.json", "project", [], root).path).toBe(join(root, "mcp.json"));
  });

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

  test("builds a secret-free blocked plan and resolves a chosen variant across selected bindings", () => {
    const source = { harness: "claude", path: "/work/.mcp.json", scope: "project" as const, servers: {
      demo: { command: "npx", args: ["demo", "--one"], env: { TOKEN: "source-secret" } },
    } };
    const targets = [
      { harness: "codex", path: "/work/.codex/config.toml", scope: "project" as const, servers: { demo: { command: "npx", args: ["demo", "--two"], env: { TOKEN: "target-secret" } }, unrelated: { command: "keep" } } },
      { harness: "opencode", path: "/work/opencode.json", scope: "project" as const, servers: {} },
    ];
    const blocked = buildMcpSyncPlan(source, targets);
    expect(blocked.plan.status).toBe("blocked-by-conflict");
    expect(blocked.plan.exitCode).toBe(2);
    expect(blocked.plan.inventory.unrelated).toEqual(["codex:unrelated"]);
    expect(blocked.plan.inventory.missing).toEqual(["opencode:demo"]);
    expect(blocked.plan.unresolvedConflicts[0].collisions).toContain("env.TOKEN");
    expect(JSON.stringify(blocked.plan)).not.toContain("source-secret");
    expect(JSON.stringify(blocked.plan)).not.toContain("target-secret");

    const resolved = buildMcpSyncPlan(source, targets, { demo: { action: "variant", variant: "claude:/work/.mcp.json" } });
    expect(resolved.plan.status).toBe("ready-for-review");
    expect(resolved.plan.operations[0].targets.map((target) => target.binding)).toEqual(["codex:/work/.codex/config.toml", "opencode:/work/opencode.json"]);
    expect(resolved.plan.operations[0].envKeys).toEqual(["TOKEN"]);
    expect(resolved.definitions.demo.env?.TOKEN).toBe("source-secret");

    const targetVariant = buildMcpSyncPlan(source, targets, { demo: { action: "variant", variant: "codex:/work/.codex/config.toml" } });
    expect(targetVariant.plan.operations[0].targets.map((target) => target.binding)).toEqual(["opencode:/work/opencode.json"]);
    expect(targetVariant.definitions.demo.env?.TOKEN).toBe("target-secret");

    const skipped = buildMcpSyncPlan(source, targets, { demo: { action: "skip" } });
    expect(skipped.plan.status).toBe("ready-for-review");
    expect(skipped.plan.skippedConflicts).toEqual(["demo"]);
    expect(skipped.plan.operations).toEqual([]);
  });

  test("treats multiple equivalent and differently named bindings as normal coexistence", () => {
    const demo = { command: "npx", args: ["demo"], env: { A: "1", B: "2" } };
    const source = { harness: "claude", path: "/work/.mcp.json", scope: "project" as const, servers: { demo } };
    const targets = [
      { harness: "codex", path: "/work/.codex/config.toml", scope: "project" as const, servers: { demo: { type: "stdio" as const, command: "npx", args: ["demo"], env: { B: "2", A: "1" }, enabled: true }, codexOnly: { command: "keep" } } },
      { harness: "opencode", path: "/work/opencode.json", scope: "project" as const, servers: { openCodeOnly: { command: "keep" } } },
    ];
    const built = buildMcpSyncPlan(source, targets);
    expect(built.plan.inventory.conflicts).toEqual([]);
    expect(built.plan.inventory.identical).toEqual(["codex:demo"]);
    expect(built.plan.inventory.unrelated).toEqual(["codex:codexOnly", "opencode:openCodeOnly"]);
    expect(built.plan.operations).toHaveLength(1);
    expect(built.plan.operations[0].targets.map((target) => target.binding)).toEqual(["opencode:/work/opencode.json"]);
  });

  test("allows only a reviewed non-overlapping merge", () => {
    const source = { harness: "claude", path: "/work/.mcp.json", scope: "project" as const, servers: { demo: { command: "npx", args: ["demo"] } } };
    const targets = [
      { harness: "claude", path: "/work/.mcp.json", scope: "project" as const, servers: source.servers },
      { harness: "codex", path: "/work/.codex/config.toml", scope: "project" as const, servers: { demo: { command: "npx", args: ["demo"], env: { TOKEN: "secret" } } } },
    ];
    const merged = buildMcpSyncPlan(source, targets, { demo: { action: "merge" } });
    expect(merged.plan.status).toBe("ready-for-review");
    expect(merged.plan.operations[0].resolution).toBe("reviewed-merge");
    expect(merged.plan.operations[0].envKeys).toEqual(["TOKEN"]);
    expect(JSON.stringify(merged.plan)).not.toContain("secret");
    expect(merged.definitions.demo.env?.TOKEN).toBe("secret");

    const colliding = buildMcpSyncPlan(
      source,
      [{ harness: "codex", path: "/work/.codex/config.toml", scope: "project" as const, servers: { demo: { command: "npx", args: ["other"] } } }],
      { demo: { action: "merge" } },
    );
    expect(colliding.plan.status).toBe("blocked-by-conflict");
    expect(colliding.plan.unresolvedConflicts[0].collisions).toContain("args");
    expect(colliding.plan.operations).toEqual([]);

    const headerCollision = buildMcpSyncPlan(
      { harness: "claude", path: "/work/.mcp.json", scope: "project", servers: { demo: { url: "https://example.test", headers: { Authorization: "one" } } } },
      [{ harness: "codex", path: "/work/.codex/config.toml", scope: "project", servers: { demo: { url: "https://example.test", headers: { authorization: "two" } } } }],
      { demo: { action: "merge" } },
    );
    expect(headerCollision.plan.status).toBe("blocked-by-conflict");
    expect(headerCollision.plan.unresolvedConflicts[0].collisions).toContain("headers.authorization");
    expect(JSON.stringify(headerCollision.plan)).not.toContain('"one"');
    expect(JSON.stringify(headerCollision.plan)).not.toContain('"two"');
  });

  test("plans an explicit direct Codex replacement from the effective definition", () => {
    const direct = { command: "npx", args: ["demo"], env: { TOKEN: "secret" } };
    const source = { harness: "pi", path: "/home/.pi/mcp/mcp.json", scope: "global" as const, servers: { demo: direct } };
    const targets = [{ harness: "codex", path: "/home/.codex/config.toml", scope: "global" as const, servers: { demo: direct }, managedWrappers: ["demo"] }];
    const built = buildMcpSyncPlan(source, targets);
    expect(built.plan.operations[0]).toMatchObject({ server: "demo", definitionSource: "pi:/home/.pi/mcp/mcp.json" });
    expect(built.plan.operations[0].targets[0].binding).toBe("codex:/home/.codex/config.toml");
    expect(JSON.stringify(built.plan)).not.toContain("agent-mcp-from-pi");
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

  test("renders Pi without losing unknown fields or unrelated servers", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const path = join(root, "mcp.json");
    writeFileSync(path, JSON.stringify({
      custom: { keep: true },
      mcpServers: { existing: { command: "existing", args: [], vendorOption: "keep" } },
    }));
    renderDirectTarget("pi", path, { added: { command: "npx", args: ["added"] } });
    const rendered = JSON.parse(readFileSync(path, "utf8"));
    expect(rendered.custom).toEqual({ keep: true });
    expect(rendered.mcpServers.existing.vendorOption).toBe("keep");
    expect(rendered.mcpServers.added).toMatchObject({ type: "stdio", command: "npx", args: ["added"] });
  });

  test("updates Codex common fields without losing unknown fields or unrelated servers", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const path = join(root, "config.toml");
    writeFileSync(path, 'theme = "keep"\n\n[mcp_servers.demo]\ncommand = "old"\nvendor_option = "keep"\n\n[mcp_servers.demo.env]\nOLD = "remove"\n\n[mcp_servers.other]\ncommand = "keep"\n');
    renderDirectTarget("codex", path, { demo: { command: "npx", args: ["demo"], env: { TOKEN: "new-secret" } } });
    const rendered = readFileSync(path, "utf8");
    expect(normalizeMcpFile(path).demo).toMatchObject({ command: "npx", args: ["demo"], env: { TOKEN: "new-secret" } });
    expect(rendered).toContain('vendor_option = "keep"');
    expect(rendered).toContain('[mcp_servers.other]');
    expect(rendered).not.toContain('OLD = "remove"');
  });

  test("updates every direct native format idempotently while preserving unknown and unrelated content", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const fixtures = [
      ["catalog", "catalog.json", JSON.stringify({ topKeep: true, mcpServers: { demo: { command: "old", vendorOption: "keep" }, other: { command: "keep" } } })],
      ["pi", "pi.json", JSON.stringify({ topKeep: true, mcpServers: { demo: { command: "old", vendorOption: "keep" }, other: { command: "keep" } } })],
      ["opencode", "opencode.json", JSON.stringify({ topKeep: true, mcp: { demo: { type: "local", command: ["old"], vendorOption: "keep" }, other: { type: "local", command: ["keep"] } } })],
      ["opencode", "opencode-v2.json", JSON.stringify({ topKeep: true, mcp: { servers: { demo: { type: "local", command: ["old"], vendorOption: "keep" }, other: { type: "local", command: ["keep"] } } } })],
      ["hermes", "hermes.yaml", "topKeep: true\nmcp_servers:\n  demo:\n    command: old\n    vendorOption: keep\n  other:\n    command: keep\n"],
      ["goose", "goose.yaml", "topKeep: true\nextensions:\n  demo:\n    type: stdio\n    cmd: old\n    vendorOption: keep\n  other:\n    type: stdio\n    cmd: keep\n"],
    ] as const;
    const chosen = { demo: { command: "npx", args: ["demo"], env: { TOKEN: "secret" } } };
    for (const [harness, filename, initial] of fixtures) {
      const path = join(root, filename);
      writeFileSync(path, initial);
      renderDirectTarget(harness, path, chosen);
      const first = readFileSync(path, "utf8");
      expect(sameMcpServer(normalizeMcpFile(path).demo, chosen.demo)).toBeTrue();
      expect(normalizeMcpFile(path).other?.command).toBe("keep");
      expect(first).toContain("vendorOption");
      expect(first).toContain("topKeep");
      renderDirectTarget(harness, path, chosen);
      expect(readFileSync(path, "utf8")).toBe(first);
    }
  });

  test("builds native Claude, Grok, and Gemini commands with scope and secret movement intact", () => {
    const server = { command: "npx", args: ["demo"], env: { TOKEN: "env-secret" }, headers: { Authorization: "header-secret" } };
    for (const harness of ["claude", "grok", "gemini"] as const) {
      const project = mcpNativeCliCommand(harness, "project", "demo", server);
      const global = mcpNativeCliCommand(harness, "global", "demo", server);
      expect(project.slice(0, 3)).toEqual([harness, "mcp", "add"]);
      expect(project).toContain("project");
      expect(global).toContain("user");
      expect(project).toContain("TOKEN=env-secret");
      expect(project).toContain("Authorization: header-secret");
      expect(project).toContain("demo");
      expect(project).toContain("npx");
    }
  });

  test("renders remote headers idempotently in every direct native format", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const remote = { demo: { url: "https://mcp.example.test", headers: { Authorization: "header-secret" } } };
    for (const [harness, filename] of [["codex", "remote.toml"], ["catalog", "catalog.json"], ["pi", "pi.json"], ["opencode", "opencode.json"], ["hermes", "hermes.yaml"], ["goose", "goose.yaml"]] as const) {
      const path = join(root, filename);
      renderDirectTarget(harness, path, remote);
      const first = readFileSync(path, "utf8");
      expect(sameMcpServer(normalizeMcpFile(path).demo, remote.demo)).toBeTrue();
      expect(normalizeMcpFile(path).demo?.headers?.Authorization).toBe("header-secret");
      renderDirectTarget(harness, path, remote);
      expect(readFileSync(path, "utf8")).toBe(first);
    }
  });

  test("applies only within the selected scope and a second dry run is clean", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const project = join(root, "project");
    const source = join(project, "source.json");
    const projectCodex = join(project, ".codex", "config.toml");
    const globalCodex = join(root, ".codex", "config.toml");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(source, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["demo"] } } }));
    writeFileSync(globalCodex, '[mcp_servers.globalOnly]\ncommand = "keep"\n');
    const run = (args: string[]) => Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "mcp", ...args], {
      cwd: project,
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const applied = run(["--from", source, "--target", "codex", "--scope", "project", "--apply", "--confirmed"]);
    expect(applied.exitCode).toBe(0);
    expect(normalizeMcpFile(projectCodex).demo?.args).toEqual(["demo"]);
    expect(normalizeMcpFile(globalCodex).globalOnly?.command).toBe("keep");
    const first = readFileSync(projectCodex, "utf8");
    const second = run(["--from", source, "--target", "codex", "--scope", "project", "--non-interactive"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain('"operations": []');
    expect(readFileSync(projectCodex, "utf8")).toBe(first);
  });

  test("copies global env values without printing them and leaves the project target untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const project = join(root, "project");
    const source = join(root, "global-source.json");
    const projectCodex = join(project, ".codex", "config.toml");
    const globalCodex = join(root, ".codex", "config.toml");
    mkdirSync(join(project, ".codex"), { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(projectCodex, '[mcp_servers.projectOnly]\ncommand = "keep"\n');
    writeFileSync(source, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["demo"], env: { TOKEN: "global-secret" } } } }));
    const result = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "mcp", "--from", source, "--target", "codex", "--scope", "global", "--apply", "--confirmed"], {
      cwd: project,
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(output).not.toContain("global-secret");
    expect(output).toContain('"envKeys": [');
    expect(normalizeMcpFile(globalCodex).demo?.env?.TOKEN).toBe("global-secret");
    expect(normalizeMcpFile(projectCodex).projectOnly?.command).toBe("keep");
  });

  test("marks apply output and secures a config rewritten by a native CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const bin = join(root, "bin");
    const grokDir = join(root, ".grok");
    const grokConfig = join(grokDir, "config.toml");
    const source = join(root, "source.json");
    mkdirSync(bin, { recursive: true });
    mkdirSync(grokDir, { recursive: true });
    writeFileSync(join(bin, "grok"), '#!/bin/sh\nchmod 664 "$HOME/.grok/config.toml"\n');
    chmodSync(join(bin, "grok"), 0o755);
    writeFileSync(grokConfig, '[mcp_servers.demo]\ncommand = "old"\n');
    writeFileSync(source, JSON.stringify({ mcpServers: { demo: { command: "new" } } }));
    const result = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "mcp", "--from", source, "--target", "grok", "--scope", "global", "--resolve", "demo=source", "--apply", "--confirmed", "--non-interactive"], {
      cwd: root,
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(root, "state") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"apply": true');
    expect(statSync(grokConfig).mode & 0o777).toBe(0o600);
  });

  test("CLI target-variant choice equalizes only the selected bindings", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const source = join(root, "source.json");
    const codex = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(source, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["source"] } } }));
    writeFileSync(codex, '[mcp_servers.demo]\ncommand = "npx"\nargs = ["chosen-target"]\n');
    const result = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "mcp", "--from", source, "--target", "codex", "--target", "opencode", "--scope", "project", "--resolve", "demo=target:codex", "--non-interactive"], {
      cwd: root,
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain(`"definitionSource": "codex:${codex}"`);
    expect(output).toContain(`"binding": "opencode:${join(root, "opencode.json")}"`);
    expect(output).not.toContain('"binding": "codex:');
    expect(output).not.toContain("chosen-target");
  });

  test("a non-interactive conflict emits a read-only plan and exits non-zero", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const bin = join(root, "bin");
    const piConfig = join(root, ".pi", "mcp", "mcp.json");
    const source = join(root, "source.json");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, ".pi", "mcp"), { recursive: true });
    writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "pi"), 0o755);
    writeFileSync(piConfig, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["old"], env: { TOKEN: "target-secret" } } } }));
    writeFileSync(source, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["new"], env: { TOKEN: "source-secret" } } } }));
    const before = readFileSync(piConfig, "utf8");
    const result = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "mcp", "--from", source, "--target", "pi", "--scope", "global", "--non-interactive"], {
      cwd: root,
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(2);
    expect(output).toContain('"status": "blocked-by-conflict"');
    expect(output).toContain('"writes": []');
    expect(output).not.toContain("source-secret");
    expect(output).not.toContain("target-secret");
    expect(readFileSync(piConfig, "utf8")).toBe(before);
  });

  test("mcp --target pi produces a global plan without writing", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const bin = join(root, "bin");
    const piConfig = join(root, ".pi", "mcp", "mcp.json");
    const source = join(root, "source.json");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, ".pi", "mcp"), { recursive: true });
    writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "pi"), 0o755);
    writeFileSync(piConfig, JSON.stringify({ mcpServers: { existing: { command: "existing" } } }));
    writeFileSync(source, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["demo"] } } }));
    const before = readFileSync(piConfig, "utf8");
    const result = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "mcp", "--from", source, "--target", "pi", "--scope", "global"], {
      cwd: root,
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(output).toContain("Missing: pi:demo");
    expect(output).toContain("Unsupported scope: none");
    expect(readFileSync(piConfig, "utf8")).toBe(before);
  });

  test("MCP comparison follows a Codex wrapper to its effective Pi definition", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const bin = join(root, "bin");
    const piDir = join(root, ".pi", "mcp");
    const codexDir = join(root, ".codex");
    mkdirSync(bin, { recursive: true });
    mkdirSync(piDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "codex"), 0o755);
    writeFileSync(join(piDir, "mcp.json"), JSON.stringify({ mcpServers: { "context-mode": { command: "npx", args: ["context-mode"] } } }));
    writeFileSync(join(codexDir, "config.toml"), '[mcp_servers."context-mode"]\ncommand = "/home/test/.codex/bin/agent-mcp-from-pi"\nargs = ["context-mode"]\n');
    const result = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "mcp", "--from", "pi", "--target", "codex"], {
      cwd: root,
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(output).toContain("Identical: codex:context-mode");
    expect(output).toContain("Conflicts: none");
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
      { harness: "codex", path: codex, scope: "project" },
    ], { version: 1, servers: {} }, "now");
    expect(manifest.servers.demo.source).toBe("demo");
    expect(manifest.servers.demo.sourceType).toBe("npm");
    expect(manifest.servers.demo.conflict).toBeTrue();
    expect(manifest.servers.demo.configHash).toBeNull();
    expect(JSON.stringify(manifest)).not.toContain("first-secret");
    expect(JSON.stringify(manifest)).not.toContain("second-secret");
  });

  test("keeps project and global definitions separate when determining conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const project = join(root, "project.json");
    const global = join(root, "global.json");
    writeFileSync(project, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["project"] } } }));
    writeFileSync(global, JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["global"] } } }));
    const manifest = scanMcpManifest([
      { harness: "claude", path: project, scope: "project" },
      { harness: "claude", path: global, scope: "global" },
    ], { version: 1, servers: {} }, "now");
    expect(manifest.servers.demo.conflict).toBeFalse();
  });

  test("resolves exact Codex agent-mcp-from-pi wrappers while retaining raw provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const pi = join(root, "mcp.json");
    const codex = join(root, "config.toml");
    writeFileSync(pi, JSON.stringify({ mcpServers: { "context-mode": { command: "npx", args: ["context-mode"], env: { TOKEN: "secret" } } } }));
    writeFileSync(codex, '[mcp_servers."context-mode"]\ncommand = "/home/test/.codex/bin/agent-mcp-from-pi"\nargs = ["context-mode"]\n');
    const manifest = scanMcpManifest([
      { harness: "codex", path: codex, scope: "global" },
      { harness: "pi", path: pi, scope: "global" },
    ], { version: 1, servers: {} }, "now");
    const codexInstall = manifest.servers["context-mode"].installations.find((item) => item.harness === "codex")!;
    expect(piServerReference({ command: "agent-mcp-from-pi", args: ["context-mode"] })).toBe("context-mode");
    expect(piServerReference({ command: "agent-mcp-from-pi-extra", args: ["context-mode"] })).toBeUndefined();
    expect(manifest.servers["context-mode"].conflict).toBeFalse();
    expect(codexInstall.indirection).toEqual({ harness: "pi", server: "context-mode", path: pi });
    expect(codexInstall.effectiveConfigHash).not.toBe(codexInstall.configHash);
    expect(JSON.stringify(manifest)).not.toContain("secret");
  });

  test("reports non-portable Pi env paths and their indirect Codex dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const pi = join(root, "mcp.json");
    const codex = join(root, "config.toml");
    writeFileSync(pi, JSON.stringify({ mcpServers: { "context-mode": { command: "npx", args: ["context-mode"], env: { CLAUDE_CONFIG_DIR: "/Users/example/.claude" } } } }));
    writeFileSync(codex, '[mcp_servers."context-mode"]\ncommand = "/home/test/.codex/bin/agent-mcp-from-pi"\nargs = ["context-mode"]\n');
    expect(inspectMcpConfigurations([
      { harness: "pi", path: pi, scope: "global" },
      { harness: "codex", path: codex, scope: "global" },
    ], "linux")).toContainEqual({
      issue: "non-portable-path",
      harness: "pi",
      path: pi,
      server: "context-mode",
      field: "env.CLAUDE_CONFIG_DIR",
      value: "/Users/example/.claude",
      indirectHarnesses: ["codex:context-mode"],
    });
  });

  test("treats tilde home references as portable", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const pi = join(root, "mcp.json");
    writeFileSync(pi, JSON.stringify({ mcpServers: { demo: { command: "npx", env: { CLAUDE_CONFIG_DIR: "~/.claude" } } } }));
    expect(inspectMcpConfigurations([{ harness: "pi", path: pi, scope: "global" }], "linux")).toEqual([]);
  });

  test("reports a harness-coupled launcher without exposing other arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const codex = join(root, "config.toml");
    writeFileSync(codex, '[mcp_servers.playwright]\ncommand = "sh"\nargs = ["-lc", "exec \\\"$HOME/.agents/opencode/mcp-launch\\\" playwright"]\n');
    expect(inspectMcpConfigurations([{ harness: "codex", path: codex, scope: "global" }], "linux")).toContainEqual({
      issue: "harness-coupled-launcher",
      harness: "codex",
      path: codex,
      server: "playwright",
      field: "args[1]",
      value: "$HOME/.agents/opencode/mcp-launch",
      indirectHarnesses: [],
    });
  });

  test("reports a missing Pi server referenced by Codex", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const pi = join(root, "mcp.json");
    const codex = join(root, "config.toml");
    writeFileSync(pi, JSON.stringify({ mcpServers: {} }));
    writeFileSync(codex, '[mcp_servers.missing]\ncommand = "agent-mcp-from-pi"\nargs = ["missing"]\n');
    expect(inspectMcpConfigurations([
      { harness: "codex", path: codex, scope: "global" },
      { harness: "pi", path: pi, scope: "global" },
    ], "linux")).toContainEqual({
      issue: "missing-pi-server",
      harness: "codex",
      path: codex,
      server: "missing",
      field: "args[0]",
      value: "missing",
      indirectHarnesses: ["codex:missing"],
      targetPath: pi,
    });
  });

  test("audit output and provenance never include MCP secret values", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sync-test-"));
    temporary.push(root);
    const piDir = join(root, ".pi", "mcp");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["demo"], env: { TOKEN: "audit-secret-value" } } } }));
    const result = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "audit", "--json"], {
      cwd: root,
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(output).not.toContain("audit-secret-value");
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

describe("CLI", () => {
  test("prints help successfully", () => {
    const result = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "harness-sync.ts"), "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("harness-sync [audit|init|instructions|add|remove|update|mcp]");
    expect(result.stderr.toString()).toBe("");
  });
});
