import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("dist/cli/main.js");

beforeAll(() => {
  execFileSync("npx", ["tsc"], { cwd: path.resolve("."), shell: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      timeout: 240000,
      cwd: path.resolve("."),
    });
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", code: err.status ?? err.code ?? 1 };
  }
}

function outputPaths(label: string): { md: string; xml: string; json: string } {
  const stem = path.join(os.tmpdir(), `120fps-ci-${label}-${process.pid}-${Date.now()}`);
  return { md: `${stem}.md`, xml: `${stem}.xml`, json: `${stem}.json` };
}

function cleanUp(paths: Record<string, string>): void {
  for (const target of Object.values(paths)) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}

describe("--ci writes an artifact that carries the run", () => {
  it("lists the measured component and agrees with exit 0", async () => {
    const out = outputPaths("pass");
    try {
      const { code } = await runCli([
        "./fixtures/static-buttons.tsx",
        "--ci",
        "--samples", "2",
        "--max-combos", "1",
        "--explore-budget", "10",
        "--no-deltas",
        "--json", out.json,
        "--report-md", out.md,
        "--report-junit", out.xml,
      ]);
      expect(code).toBe(0);
      const md = fs.readFileSync(out.md, "utf-8");
      const xml = fs.readFileSync(out.xml, "utf-8");
      expect(md).toContain("1 component,");
      expect(md).toContain("static-buttons.tsx");
      expect(md).toContain("**PASS**");
      expect(xml).toContain('tests="1"');
      expect(xml).toContain('failures="0"');
    } finally {
      cleanUp(out);
    }
  }, 300000);

  it("headlines a failure and counts it when the run exits 1", async () => {
    const out = outputPaths("fail");
    try {
      const { code } = await runCli([
        "./fixtures/static-buttons.tsx",
        "--ci",
        "--samples", "2",
        "--max-combos", "1",
        "--explore-budget", "10",
        "--no-deltas",
        "--threshold-mount", "0.001",
        "--json", out.json,
        "--report-md", out.md,
        "--report-junit", out.xml,
      ]);
      expect(code).toBe(1);
      const md = fs.readFileSync(out.md, "utf-8");
      const xml = fs.readFileSync(out.xml, "utf-8");
      expect(md).toContain("**FAIL**");
      expect(md).toContain("1 component,");
      expect(xml).toContain('tests="1"');
      expect(xml).toContain('failures="1"');
    } finally {
      cleanUp(out);
    }
  }, 300000);
});
