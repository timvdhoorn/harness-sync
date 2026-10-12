import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFrontmatterOverrides, buildMcpSyncPlan, frontmatterValues, inspectMcpBindings, inspectSkillOverrides, missingLocalSkillSource, normalizeMcpFile, setMcpBinding } from "../scripts/harness-sync";

const temporary: string[] = [];
const script = join(import.meta.dir, "..", "scripts", "harness-sync.ts");
const envSecret = "fixture-env-secret-value";
const headerSecret = "fixture-header-secret-value";

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-sync-library-"));
  temporary.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "projects", "app"), { recursive: true });
  mkdirSync(join(root, ".agents", "mcp"), { recursive: true });
  writeFileSync(join(root, ".agents", "mcp", "mcp.json"), JSON.stringify({
    mcpServers: {
      "example-server": { command: "npx", args: ["example-server"], env: { API_KEY: envSecret } },
      "remote-server": { type: "http", url: "https://mcp.example.test", headers: { Authorization: `Bearer ${headerSecret}` } },
    },
  }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: {}, projects: { "/elsewhere": { allowedTools: ["keep"] } } }));
  fakeBin(root, "claude", "exit 0");
  return root;
}

function fakeBin(root: string, name: string, body: string): void {
  writeFileSync(join(root, "bin", name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(root, "bin", name), 0o755);
}

function cliEnv(root: string) {
  return { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), PATH: `${join(root, "bin")}:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
}

function cli(root: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", script, ...args], { cwd: join(root, "projects", "app"), env: cliEnv(root), stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function planJson(stdout: string): any {
  return JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
}

function strictFindings(root: string): any[] {
  return JSON.parse(cli(root, "audit", "--strict", "--json").stdout).strict.findings;
}

describe("MCP bindings", () => {
  test("a disabled binding is skipped with a reason and never reported as missing", () => {
    const source = { harness: "catalog", path: "/catalog.json", scope: "global" as const, servers: { "example-server": { command: "npx" }, other: { command: "other" } } };
    const target = { harness: "claude", path: "/claude.json", scope: "global" as const, servers: {} };
    const { plan } = buildMcpSyncPlan(source, [target], {}, "non-interactive", "linux", (server, harness) => server === "example-server" && harness === "claude" ? false : undefined);
    expect(plan.skippedDisabled).toEqual([{ server: "example-server", binding: "claude:/claude.json", reason: "disabled-by-binding" }]);
    expect(plan.operations.map((operation) => operation.server)).toEqual(["other"]);
    expect(plan.inventory.missing).toEqual(["claude:other"]);
  });

  test("a disabled binding with a different target definition is not a conflict", () => {
    const source = { harness: "catalog", path: "/catalog.json", scope: "global" as const, servers: { "example-server": { command: "npx" } } };
    const target = { harness: "codex", path: "/config.toml", scope: "global" as const, servers: { "example-server": { command: "different" } } };
    const { plan } = buildMcpSyncPlan(source, [target], {}, "non-interactive", "linux", () => false);
    expect(plan.status).toBe("ready-for-review");
    expect(plan.unresolvedConflicts).toEqual([]);
    expect(plan.operations).toEqual([]);
  });

  test("reports drift between desired and actual state", () => {
    let bindings = setMcpBinding({ version: 1, servers: {} }, "example-server", "claude", false);
    bindings = setMcpBinding(bindings, "example-server", "claude", true, "~/projects/app");
    bindings = setMcpBinding(bindings, "gone-server", "codex", true);
    const actual = (harness: string, scope: string) => new Set(harness === "claude" && scope === "global" ? ["example-server"] : []);
    expect(inspectMcpBindings(bindings, ["example-server"], actual).map((item) => `${item.server}:${item.harness}:${item.scope}:${item.issue}`)).toEqual([
      "example-server:claude:global:disabled-present",
      "example-server:claude:project:enabled-missing",
      "gone-server:codex:global:enabled-missing",
      "gone-server:codex:global:unknown-server",
    ]);
  });

  test("mcp-disable records the choice and a global sync no longer proposes the server", () => {
    const root = fixture();
    const dry = cli(root, "mcp-disable", "--server", "example-server", "--target", "claude");
    expect(dry.exitCode).toBe(0);
    expect(planJson(dry.stdout).writes).toEqual([]);
    expect(() => readFileSync(join(root, ".agents", "mcp", "bindings.json"))).toThrow();
    const applied = cli(root, "mcp-disable", "--server", "example-server", "--target", "claude", "--apply", "--confirmed");
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".agents", "mcp", "bindings.json"), "utf8"))).toEqual({ version: 1, servers: { "example-server": { claude: { global: false } } } });
    const sync = cli(root, "mcp", "--from", "catalog", "--target", "claude", "--scope", "global", "--non-interactive");
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toContain("Disabled by binding: claude:example-server");
    const plan = planJson(sync.stdout);
    expect(plan.skippedDisabled).toEqual([{ server: "example-server", binding: `claude:${join(root, ".claude.json")}`, reason: "disabled-by-binding" }]);
    expect(plan.operations.map((operation: any) => operation.server)).toEqual(["remote-server"]);
    expect(sync.stdout).not.toContain(envSecret);
    expect(sync.stdout).not.toContain(headerSecret);
  });

  test("paths from ~/.agents/harness-sync/config.json relocate the catalog and bindings", () => {
    const root = fixture();
    mkdirSync(join(root, ".agents", "library"), { recursive: true });
    writeFileSync(join(root, ".agents", "library", "servers.json"), readFileSync(join(root, ".agents", "mcp", "mcp.json")));
    rmSync(join(root, ".agents", "mcp"), { recursive: true });
    mkdirSync(join(root, ".agents", "harness-sync"), { recursive: true });
    writeFileSync(join(root, ".agents", "harness-sync", "config.json"), JSON.stringify({ paths: { mcpCatalog: "~/.agents/library/servers.json", mcpBindings: "~/.agents/library/bindings.json" } }));
    const applied = cli(root, "mcp-disable", "--server", "example-server", "--target", "claude", "--apply", "--confirmed");
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".agents", "library", "bindings.json"), "utf8")).servers["example-server"].claude.global).toBe(false);
    expect(() => readFileSync(join(root, ".agents", "mcp", "bindings.json"))).toThrow();
    const sync = cli(root, "mcp", "--from", "catalog", "--target", "claude", "--scope", "global", "--non-interactive");
    expect(planJson(sync.stdout).operations.map((operation: any) => operation.server)).toEqual(["remote-server"]);
  });

  test("an environment variable overrides the configured bindings path", () => {
    const root = fixture();
    const result = Bun.spawnSync([process.execPath, "run", script, "mcp-disable", "--server", "example-server", "--target", "claude", "--apply", "--confirmed"], {
      cwd: join(root, "projects", "app"),
      env: { ...cliEnv(root), HARNESS_SYNC_MCP_BINDINGS: join(root, "custom-bindings.json") },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "custom-bindings.json"), "utf8")).version).toBe(1);
  });

  test("mcp-enable --project renders Claude local scope and preserves the rest of the config", () => {
    const root = fixture();
    const project = join(root, "projects", "app");
    const applied = cli(root, "mcp-enable", "--server", "example-server", "--target", "claude", "--project", "~/projects/app", "--apply", "--confirmed");
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).not.toContain(envSecret);
    const claude = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8"));
    expect(claude.numStartups).toBe(3);
    expect(claude.projects["/elsewhere"]).toEqual({ allowedTools: ["keep"] });
    expect(claude.projects[project].mcpServers["example-server"]).toEqual({ type: "stdio", command: "npx", args: ["example-server"], env: { API_KEY: envSecret } });
    expect(Object.keys(claude.mcpServers)).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, ".agents", "mcp", "bindings.json"), "utf8")).servers["example-server"].claude.projects).toEqual({ "~/projects/app": true });
    expect(strictFindings(root).filter((item) => item.code.startsWith("mcp-binding"))).toEqual([]);

    delete claude.projects[project].mcpServers["example-server"];
    claude.mcpServers["example-server"] = { command: "npx", args: ["example-server"] };
    writeFileSync(join(root, ".claude.json"), JSON.stringify(claude));
    cli(root, "mcp-disable", "--server", "example-server", "--target", "claude");
    const bindings = JSON.parse(readFileSync(join(root, ".agents", "mcp", "bindings.json"), "utf8"));
    bindings.servers["example-server"].claude.global = false;
    writeFileSync(join(root, ".agents", "mcp", "bindings.json"), JSON.stringify(bindings));
    const findings = strictFindings(root).filter((item) => item.code.startsWith("mcp-binding"));
    expect(findings.map((item) => `${item.code}:${item.scope}`).sort()).toEqual(["mcp-binding-disabled-present:global", "mcp-binding-enabled-missing:project"]);
    expect(findings.find((item) => item.scope === "project").project).toBe("~/projects/app");

    const removed = cli(root, "mcp-disable", "--server", "example-server", "--target", "claude", "--project", "~/projects/app", "--apply", "--confirmed");
    expect(removed.exitCode).toBe(0);
    expect(planJson(removed.stdout).changes[0].operation).toBe("none");
  });

  test("mcp-enable and mcp-disable render and remove a direct global target", () => {
    const root = fixture();
    const codex = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"));
    writeFileSync(codex, 'model = "example"\n');
    expect(cli(root, "mcp-enable", "--server", "example-server", "--target", "codex", "--apply", "--confirmed").exitCode).toBe(0);
    expect(normalizeMcpFile(codex)["example-server"]?.args).toEqual(["example-server"]);
    const disabled = cli(root, "mcp-disable", "--server", "example-server", "--target", "codex", "--apply", "--confirmed");
    expect(disabled.exitCode).toBe(0);
    expect(planJson(disabled.stdout).changes[0]).toMatchObject({ operation: "remove", before: true, desired: false });
    expect(normalizeMcpFile(codex)["example-server"]).toBeUndefined();
    expect(readFileSync(codex, "utf8")).toContain('model = "example"');
  });

  test("rejects unknown servers, project bindings outside Claude, and invalid binding files", () => {
    const root = fixture();
    expect(cli(root, "mcp-enable", "--server", "missing-server", "--target", "codex").stderr).toContain("not found");
    expect(cli(root, "mcp-enable", "--server", "example-server", "--target", "codex", "--project", "~/projects/app").stderr).toContain("claude only");
    writeFileSync(join(root, ".agents", "mcp", "bindings.json"), JSON.stringify({ version: 1, servers: { "example-server": { unknown: { global: true } } } }));
    const sync = cli(root, "mcp", "--from", "catalog", "--target", "claude", "--scope", "global", "--non-interactive");
    expect(sync.exitCode).toBe(1);
    expect(sync.stderr).toContain("unsupported harness");
    expect(strictFindings(root).map((item) => item.code)).toContain("mcp-bindings-invalid");
  });
});

describe("skill overrides", () => {
  test("sets scalar frontmatter keys and leaves other lines and the body untouched", () => {
    const text = "---\nname: demo\nmetadata:\n  nested: true\ndescription: Demo skill.\n---\n\n# Body\n";
    const added = applyFrontmatterOverrides(text, { "disable-model-invocation": true });
    expect(added).toBe("---\nname: demo\nmetadata:\n  nested: true\ndescription: Demo skill.\ndisable-model-invocation: true\n---\n\n# Body\n");
    expect(applyFrontmatterOverrides(added, { "disable-model-invocation": true })).toBe(added);
    const replaced = applyFrontmatterOverrides(added, { metadata: "flat", "disable-model-invocation": false });
    expect(frontmatterValues(replaced)).toEqual({ name: "demo", metadata: "flat", description: "Demo skill.", "disable-model-invocation": false });
    expect(replaced.endsWith("---\n\n# Body\n")).toBeTrue();
    expect(() => applyFrontmatterOverrides(text, { name: "other" })).toThrow("invalid frontmatter override key");
  });

  test("reports missing overrides and absent skills separately", () => {
    const root = fixture();
    const canonical = join(root, ".agents", "skills");
    mkdirSync(join(canonical, "demo"), { recursive: true });
    writeFileSync(join(canonical, "demo", "SKILL.md"), "---\nname: demo\n---\nbody\n");
    const issues = inspectSkillOverrides({ version: 1, skills: { demo: { frontmatter: { "disable-model-invocation": true } }, absent: { frontmatter: { "disable-model-invocation": true } } } }, canonical);
    expect(issues.map((item) => `${item.skill}:${item.issue}`)).toEqual(["absent:skill-missing", "demo:override-missing"]);
  });

  test("detects a local install source that no longer exists", () => {
    const base = { sourceType: "local", sourceUrl: null, skillPath: null, version: "v", contentHash: "h", installedAt: null, updatedAt: "now", provenance: "install" as const };
    expect(missingLocalSkillSource({ ...base, source: "/nonexistent/skills/demo" })).toBe("/nonexistent/skills/demo");
    expect(missingLocalSkillSource({ ...base, source: tmpdir() })).toBeUndefined();
    expect(missingLocalSkillSource({ ...base, sourceType: "github", source: "owner/repo" })).toBeUndefined();
  });

  test("skill-override records, applies, and update reapplies it; a missing source keeps the canonical copy", () => {
    const root = fixture();
    const canonical = join(root, ".agents", "skills");
    for (const name of ["demo", "local-demo"]) {
      mkdirSync(join(canonical, name), { recursive: true });
      writeFileSync(join(canonical, name, "SKILL.md"), `---\nname: ${name}\ndescription: Before.\n---\nbody\n`);
    }
    fakeBin(root, "npx", `printf -- '---\\nname: demo\\ndescription: Upstream.\\n---\\nupstream body\\n' > "$HOME/.agents/skills/demo/SKILL.md"`);
    mkdirSync(join(root, "state", "harness-sync"), { recursive: true });
    writeFileSync(join(root, "state", "harness-sync", "skills.json"), JSON.stringify({ version: 1, skills: {
      demo: { source: "owner/repo", sourceType: "github", sourceUrl: null, skillPath: null, version: "v1", contentHash: "old", installedAt: null, updatedAt: "then", provenance: "install" },
      "local-demo": { source: join(root, "missing-library", "local-demo"), sourceType: "local", sourceUrl: null, skillPath: null, version: "v1", contentHash: "old", installedAt: null, updatedAt: "then", provenance: "install" },
    } }));

    const recorded = cli(root, "skill-override", "--skill", "demo", "--skill", "local-demo", "--set", "disable-model-invocation=true", "--apply", "--confirmed");
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".agents", "skills-overrides.json"), "utf8"))).toEqual({ version: 1, skills: {
      demo: { frontmatter: { "disable-model-invocation": true } },
      "local-demo": { frontmatter: { "disable-model-invocation": true } },
    } });
    const localBefore = readFileSync(join(canonical, "local-demo", "SKILL.md"), "utf8");
    expect(frontmatterValues(localBefore)?.["disable-model-invocation"]).toBeTrue();

    const plan = cli(root, "update");
    expect(plan.stdout).toContain("reapply overrides: disable-model-invocation");
    expect(plan.stdout).toContain("Skip (source no longer exists; canonical copy kept): local-demo");
    const updated = cli(root, "update", "--apply", "--confirmed");
    expect(updated.exitCode).toBe(0);
    const demo = readFileSync(join(canonical, "demo", "SKILL.md"), "utf8");
    expect(demo).toContain("upstream body");
    expect(frontmatterValues(demo)?.["disable-model-invocation"]).toBeTrue();
    expect(readFileSync(join(canonical, "local-demo", "SKILL.md"), "utf8")).toBe(localBefore);
    expect(strictFindings(root).filter((item) => item.code.startsWith("skill-override"))).toEqual([]);

    writeFileSync(join(canonical, "demo", "SKILL.md"), "---\nname: demo\n---\nreverted\n");
    expect(strictFindings(root).filter((item) => item.code.startsWith("skill-override")).map((item) => `${item.code}:${item.skill}:${item.key}`)).toEqual(["skill-override-override-missing:demo:disable-model-invocation"]);
    expect(cli(root, "skill-override", "--apply", "--confirmed").exitCode).toBe(0);
    expect(frontmatterValues(readFileSync(join(canonical, "demo", "SKILL.md"), "utf8"))?.["disable-model-invocation"]).toBeTrue();
  });

  test("add reapplies a recorded override to the installed skill", () => {
    const root = fixture();
    const canonical = join(root, ".agents", "skills");
    mkdirSync(join(canonical, "demo"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills-overrides.json"), JSON.stringify({ version: 1, skills: { demo: { frontmatter: { "disable-model-invocation": true } } } }));
    fakeBin(root, "npx", `printf -- '---\\nname: demo\\n---\\nfresh\\n' > "$HOME/.agents/skills/demo/SKILL.md"`);
    const added = cli(root, "add", "owner/repo", "--skill", "demo", "--apply", "--confirmed");
    expect(added.exitCode).toBe(0);
    expect(frontmatterValues(readFileSync(join(canonical, "demo", "SKILL.md"), "utf8"))?.["disable-model-invocation"]).toBeTrue();
  });
});

describe("dashboard", () => {
  test("serves read-only HTML and JSON on localhost without secret values", async () => {
    const root = fixture();
    mkdirSync(join(root, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndisable-model-invocation: true\n---\nbody\n");
    const claude = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8"));
    claude.mcpServers["example-server"] = { command: "npx", args: ["example-server"], env: { API_KEY: envSecret } };
    claude.projects[join(root, "projects", "app")] = { mcpServers: { "remote-server": { type: "http", url: "https://mcp.example.test", headers: { Authorization: `Bearer ${headerSecret}` } } } };
    writeFileSync(join(root, ".claude.json"), JSON.stringify(claude));
    writeFileSync(join(root, ".agents", "mcp", "bindings.json"), JSON.stringify({ version: 1, servers: { "example-server": { claude: { global: false } } } }));

    const server = Bun.spawn([process.execPath, "run", script, "serve", "--port", "0"], { cwd: join(root, "projects", "app"), env: cliEnv(root), stdout: "pipe", stderr: "pipe" });
    try {
      const reader = server.stdout.getReader();
      let output = "";
      while (!output.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      expect(url).toBeDefined();
      const page = await fetch(url!);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain("example-server");
      expect(html).toContain("remote-server");
      expect(html).toContain("manual only");
      expect(html).toContain('class="cell drift"');
      const json = await (await fetch(`${url}api/status`)).text();
      expect(JSON.parse(json).mcp.rows.find((row: any) => row.server === "example-server").cells[0]).toEqual({ desired: false, present: true, status: "drift" });
      for (const body of [html, json]) {
        expect(body).not.toContain(envSecret);
        expect(body).not.toContain(headerSecret);
        expect(body).not.toContain("API_KEY");
      }
      expect((await fetch(url!, { method: "POST" })).status).toBe(405);
    } finally {
      server.kill();
      await server.exited;
    }
  });

  test("rejects an invalid port", () => {
    const root = fixture();
    expect(cli(root, "serve", "--port", "99999").stderr).toContain("--port must be");
  });
});
