import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstructions, normalizeAddInput, normalizeMcpJson, removalTargets, validSkillName } from "../scripts/harness-sync";

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
