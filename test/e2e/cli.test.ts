import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("dist/cli.js");

beforeAll(() => {
  execFileSync("npx", ["tsc"], { cwd: path.resolve("."), shell: true });
});

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, ...args],
      { timeout: 120000, cwd: path.resolve(".") },
    );
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: err.status ?? err.code ?? 1,
    };
  }
}

describe("CLI e2e", () => {
  it("prints help with --help and exits 0", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("120fps");
  });

  it("prints version with --version and exits 0", async () => {
    const { stdout, code } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  it("exits 2 for missing component path", async () => {
    const { code } = await runCli([]);
    expect(code).toBe(2);
  });

  it("exits 2 for non-existent file", async () => {
    const { code } = await runCli(["./nonexistent.tsx"]);
    expect(code).toBe(2);
  });

  it("runs full analysis and writes JSON", async () => {
    const jsonPath = path.join(os.tmpdir(), `cli-test-${Date.now()}.json`);
    const { stdout, code } = await runCli([
      "./fixtures/static-buttons.tsx",
      "--samples", "3",
      "--json", jsonPath,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("StaticButtons");
    expect(fs.existsSync(jsonPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(report.version).toBe(1);
    fs.unlinkSync(jsonPath);
  }, 120000);

  it("CI mode returns exit 1 on fail threshold", async () => {
    const jsonPath = path.join(os.tmpdir(), `cli-ci-${Date.now()}.json`);
    const { code, stdout } = await runCli([
      "./fixtures/static-buttons.tsx",
      "--samples", "3",
      "--ci",
      "--json", jsonPath,
      "--threshold-mount", "0.001",
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(fs.existsSync(jsonPath)).toBe(true);
    fs.unlinkSync(jsonPath);
  }, 120000);
});
