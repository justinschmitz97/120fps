import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const CLI = path.resolve("dist/cli/main.js");

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// Unit tests miss this: `main()` runs at import time, hitting a TDZ bug only the binary shows.
describe("the built CLI expands paths", () => {
  it("reports a usage error naming the argument that matched nothing", async () => {
    const { code, stderr } = await cli(["./fixtures/definitely-not-here"]);
    expect(code).toBe(2);
    expect(stderr).toContain("definitely-not-here");
    expect(stderr).not.toContain("ReferenceError");
  });

  it("does not crash on a directory argument", async () => {
    // --help short-circuits before measuring, keeping this fast on the same init path.
    const { code, stdout, stderr } = await cli(["./fixtures", "--help"]);
    expect(stderr).not.toContain("ReferenceError");
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("documents the new flags", async () => {
    const { stdout } = await cli(["--help"]);
    expect(stdout).toContain("--max-combos");
    expect(stdout).toContain("--explore-budget");
    expect(stdout).toContain("--init-fixture");
  });
});
