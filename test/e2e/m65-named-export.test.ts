import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const CLI = path.resolve("dist/cli.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m65-"));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("M65 — <file>#Export end to end", () => {
  it("measures the named export, not the one the resolver would pick", async () => {
    const jsonPath = path.join(tmpDir, "secondary.json");
    const { code, stdout } = await cli([
      "./fixtures/two-exports.tsx#SecondaryBtn",
      "--json",
      jsonPath,
      "--samples",
      "2",
      "--max-combos",
      "2",
      "--no-react-analysis",
      "--no-auto-scale",
      "--explore-budget",
      "2",
    ]);
    expect([0, 1]).toContain(code);

    const report = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(report.componentName).toBe("SecondaryBtn");
    const propNames = new Set(report.combos.flatMap((c: { props: object }) => Object.keys(c.props)));
    expect(propNames.has("text") || propNames.has("outlined")).toBe(true);
    expect(propNames.has("label")).toBe(false);
    expect(report.combos.some((c: { domNodeCount: number }) => c.domNodeCount > 0)).toBe(true);

    // C2/C3 ride along on the same run: phase markers and a wall-clock line.
    expect(stdout).toContain("harness: building");
    expect(stdout).toMatch(/^mount: /m);
    expect(stdout).toMatch(/^Total: /m);
  }, 180_000);

  it("rejects an export the file does not have, listing the ones it does", async () => {
    const { code, stderr } = await cli(["./fixtures/two-exports.tsx#Nope"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Nope");
    expect(stderr).toContain("PrimaryBtn");
    expect(stderr).toContain("SecondaryBtn");
  });

  it("--explain-props prints the resolution and writes nothing", async () => {
    const jsonPath = path.join(tmpDir, "never-written.json");
    const { code, stdout } = await cli([
      "./fixtures/two-exports.tsx",
      "--explain-props",
      "--json",
      jsonPath,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("Component: PrimaryBtn");
    expect(stdout).toContain("Props (2):");
    expect(stdout).toContain("Curve mode:");
    expect(stdout).toContain("Matrix mode:");
    expect(fs.existsSync(jsonPath)).toBe(false);
  });

  it("--explain-props follows an explicit export target", async () => {
    const { code, stdout } = await cli([
      "./fixtures/two-exports.tsx#SecondaryBtn",
      "--explain-props",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("Component: SecondaryBtn");
    expect(stdout).toContain("outlined");
  });

  it("names the provider candidate when the component throws on mount", async () => {
    const jsonPath = path.join(tmpDir, "provider.json");
    const { code, stdout } = await cli([
      "./fixtures/m65/workbench-consumer.tsx",
      "--json",
      jsonPath,
      "--samples",
      "2",
      "--max-combos",
      "1",
      "--no-react-analysis",
      "--no-auto-scale",
      "--explore-budget",
      "2",
    ]);
    expect(code).toBe(1);

    const report = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(report.combos.some((c: { renderHealth?: string }) => c.renderHealth === "error")).toBe(
      true,
    );
    expect(report.providerCandidates).toEqual([
      "fixtures/m65/workbench-store.tsx (useWorkbench)",
    ]);
    expect(stdout).toContain("component imports fixtures/m65/workbench-store.tsx (useWorkbench)");
    expect(stdout).toContain("120fps.setup.tsx");
  }, 180_000);

  it("a healthy component carries no provider candidates", async () => {
    const jsonPath = path.join(tmpDir, "healthy.json");
    await cli([
      "./fixtures/m65/healthy-consumer.tsx",
      "--json",
      jsonPath,
      "--samples",
      "2",
      "--max-combos",
      "1",
      "--no-react-analysis",
      "--no-auto-scale",
      "--explore-budget",
      "2",
    ]);
    const report = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(report.providerCandidates).toBeUndefined();
  }, 180_000);

  it("--explain-props over several paths explains each and fails on the bad one", async () => {
    const { code, stdout, stderr } = await cli([
      "./fixtures/two-exports.tsx",
      "./fixtures/m58/hotspot-image.tsx#Nope",
      "--explain-props",
    ]);
    expect(code).toBe(2);
    expect(stdout).toContain("Component: PrimaryBtn");
    expect(stderr).toContain("Nope");
    expect(stderr).toContain("HotspotImage");
  });

  it("--ci prints neither progress markers nor a total line", async () => {
    const jsonPath = path.join(tmpDir, "ci.json");
    const { stdout } = await cli([
      "./fixtures/no-props.tsx",
      "--ci",
      "--json",
      jsonPath,
      "--samples",
      "2",
      "--no-react-analysis",
      "--no-auto-scale",
      "--explore-budget",
      "2",
    ]);
    expect(stdout).not.toContain("harness: building");
    expect(stdout).not.toContain("Total: ");
  }, 180_000);
});
