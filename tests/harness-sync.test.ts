import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAddInput, normalizeMcpJson, validSkillName } from "../scripts/harness-sync";

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

