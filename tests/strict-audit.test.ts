import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-sync-strict-audit-"));
  temporary.push(root);
  mkdirSync(join(root, ".agents", "skills", "demo"), { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "project"));
  writeFileSync(join(root, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\ndemo\n");
  return root;
}

function runAudit(root: string, ...args: string[]) {
  return Bun.spawnSync([
    process.execPath,
    "run",
    join(import.meta.dir, "..", "scripts", "harness-sync.ts"),
    "audit",
    ...args,
  ], {
    cwd: join(root, "project"),
    env: {
      ...process.env,
      HOME: root,
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      XDG_STATE_HOME: join(root, "state"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function auditJson(root: string, strict = true): { result: ReturnType<typeof runAudit>; audit: any } {
  const result = runAudit(root, ...(strict ? ["--strict", "--json"] : ["--json"]));
  return { result, audit: JSON.parse(result.stdout.toString()) };
}

function snapshot(root: string): string {
  const entries: string[] = [];
  const visit = (path: string, relativePath: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      entries.push(`${relativePath}:link:${readlinkSync(path)}`);
      return;
    }
    if (info.isDirectory()) {
      entries.push(`${relativePath}:directory`);
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(relativePath, name));
      return;
    }
    entries.push(`${relativePath}:file:${readFileSync(path).toString("base64")}`);
  };
  visit(root, ".");
  return entries.join("\n");
}

function write(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

describe("strict audit CLI", () => {
  test("returns exit 1 for an actionable broken skill link", () => {
    const root = fixture();
    const claudeSkills = join(root, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });
    symlinkSync("missing-target", join(claudeSkills, "demo"));

    const { result, audit } = auditJson(root);
    expect(audit.skills.find((item: { id: string }) => item.id === "claude").issues).toContainEqual({
      path: join(claudeSkills, "demo"),
      issue: "broken-skill-link",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
  });

  test("keeps the default audit informational on the same broken state", () => {
    const root = fixture();
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    symlinkSync("missing", join(root, ".claude", "skills", "demo"));
    const { result, audit } = auditJson(root, false);
    expect(result.exitCode).toBe(0);
    expect(audit.strict).toBeUndefined();
    expect(audit.skills.find((item: { id: string }) => item.id === "claude").issues).not.toBeEmpty();
  });

  test("accepts unknown provenance, matching copies, valid untracked skills and absent optional harnesses", () => {
    const root = fixture();
    write(root, ".pi/mcp/mcp.json", JSON.stringify({ mcpServers: { local: { command: "custom-local-server" } } }));
    write(root, ".claude/skills/demo/SKILL.md", readFileSync(join(root, ".agents/skills/demo/SKILL.md"), "utf8"));
    write(root, ".claude/skills/manual/SKILL.md", "---\nname: manual\n---\nmanual\n");
    const before = snapshot(root);
    const { result, audit } = auditJson(root);
    expect(result.exitCode).toBe(0);
    expect(audit.strict).toEqual({ actionable: false, findings: [] });
    expect(audit.mcpProvenance.unknown).toBe(1);
    expect(audit.instructions.every((item: { status: string }) => item.status === "missing-agents")).toBeTrue();
    expect(snapshot(root)).toBe(before);
  });

  test.each([
    ["invalid metadata", "bad metadata", "canonical-invalid-metadata"],
    ["wrong name", "---\nname: other\n---\n", "canonical-invalid-metadata"],
  ])("fails on canonical %s", (_label, content, code) => {
    const root = fixture();
    write(root, ".agents/skills/demo/SKILL.md", content);
    const { result, audit } = auditJson(root);
    expect(result.exitCode).toBe(1);
    expect(audit.strict.findings).toContainEqual({ code, path: join(root, ".agents/skills/demo") });
  });

  test("fails on embedded canonical skills", () => {
    const root = fixture();
    write(root, ".agents/skills/demo/nested/SKILL.md", "---\nname: nested\n---\n");
    const { result, audit } = auditJson(root);
    expect(result.exitCode).toBe(1);
    expect(audit.strict.findings).toContainEqual({ code: "canonical-nested-skill", path: join(root, ".agents/skills/demo/nested/SKILL.md") });
  });

  test("fails on a changed copy and a wrong directory link", () => {
    const root = fixture();
    write(root, ".claude/skills/demo/SKILL.md", "---\nname: demo\n---\nchanged\n");
    mkdirSync(join(root, ".codex"));
    symlinkSync(join(root, "bin"), join(root, ".codex/skills"));
    const { result, audit } = auditJson(root);
    expect(result.exitCode).toBe(1);
    expect(audit.strict.findings).toContainEqual({ code: "skill-copy-drift", path: join(root, ".claude/skills/demo") });
    expect(audit.strict.findings).toContainEqual({ code: "skill-wrong-directory-link", path: join(root, ".codex/skills") });
  });

  test.each(["missing", "conflict", "wrong-link"])("fails on a %s Claude entrypoint when canonical instructions exist", (state) => {
    const root = fixture();
    write(root, "project/AGENTS.md", "Project instructions\n");
    if (state === "conflict") write(root, "project/CLAUDE.md", "Unrelated instructions\n");
    if (state === "wrong-link") symlinkSync("missing.md", join(root, "project/CLAUDE.md"));
    const before = snapshot(root);
    const { result, audit } = auditJson(root);
    expect(result.exitCode).toBe(1);
    expect(audit.strict.findings).toContainEqual({ code: `instructions-${state === "missing" ? "missing-claude" : state}`, path: join(root, "project/CLAUDE.md") });
    expect(snapshot(root)).toBe(before);
  });

  test("accepts a canonical instruction link", () => {
    const root = fixture();
    write(root, "project/AGENTS.md", "Project instructions\n");
    symlinkSync("AGENTS.md", join(root, "project/CLAUDE.md"));
    expect(auditJson(root).result.exitCode).toBe(0);
  });

  test("fails on same-scope MCP conflicts while preserving global/project coexistence", () => {
    const root = fixture();
    write(root, ".pi/mcp/mcp.json", JSON.stringify({ mcpServers: { demo: { command: "global-server" } } }));
    write(root, "project/.mcp.json", JSON.stringify({ mcpServers: { demo: { command: "project-server" } } }));
    expect(auditJson(root).result.exitCode).toBe(0);
    write(root, ".gemini/settings.json", JSON.stringify({ mcpServers: { demo: { command: "different-server" } } }));
    const before = snapshot(root);
    const { result, audit } = auditJson(root);
    expect(result.exitCode).toBe(1);
    expect(audit.mcpProvenance.conflicts).toContain("demo");
    expect(audit.strict.findings.find((item: { code: string }) => item.code === "mcp-same-scope-conflict")).toMatchObject({ server: "demo", scope: "global" });
    expect(snapshot(root)).toBe(before);
  });

  test("fails on a missing Pi wrapper dependency", () => {
    const root = fixture();
    write(root, ".codex/config.toml", '[mcp_servers.demo]\ncommand = "/tmp/agent-mcp-from-pi"\nargs = ["missing"]\n');
    const { result, audit } = auditJson(root);
    expect(result.exitCode).toBe(1);
    expect(audit.strict.findings).toContainEqual({ code: "mcp-missing-pi-server", path: join(root, ".codex/config.toml"), server: "demo", field: "args[0]" });
  });

  test("fails on a Codex app launcher installed in another harness", () => {
    const root = fixture();
    write(root, ".pi/mcp/mcp.json", JSON.stringify({ mcpServers: { demo: { command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl" } } }));
    const { result, audit } = auditJson(root);
    expect(result.exitCode).toBe(1);
    expect(audit.strict.findings.some((item: { code: string }) => item.code === "mcp-app-owned-harness")).toBeTrue();
  });

  test.skipIf(platform() !== "linux")("redacts sensitive portability values in both audit formats and modes without writes", () => {
    const root = fixture();
    const secret = "/Users/private-secret-token";
    write(root, ".pi/mcp/mcp.json", JSON.stringify({ mcpServers: { demo: { command: "custom", env: { CONFIG: secret, TOKEN: "confidential-fixture" }, headers: { Authorization: "Bearer confidential-fixture" } } } }));
    const before = snapshot(root);
    for (const args of [[], ["--json"], ["--strict"], ["--strict", "--json"]]) {
      const result = runAudit(root, ...args);
      expect(result.exitCode).toBe(args.includes("--strict") ? 1 : 0);
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain(secret);
      expect(output).not.toContain("confidential-fixture");
      expect(output).toContain("env.CONFIG");
      expect(output).toContain("[redacted]");
    }
    expect(snapshot(root)).toBe(before);
  });
});
