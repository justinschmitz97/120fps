import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze } from "../../src/analyze.js";
import { formatStylesheetsLine, type CssReport } from "../../src/report.js";
import type { ServerPool } from "../../src/harness.js";

// M90: the stylesheet decision (`Stylesheets:` line) currently prints only
// inside the final report block, so a run that throws before that block is
// assembled discloses nothing — dub printed it in 0 of 12 runs. This suite
// pins the fix: the same decision, formatted once, folded into the
// crash-path "Warnings recorded before this failure:" block that already
// survives a `buildAndServe` throw, for every thrown shape.

function poolThatThrows(err: unknown): ServerPool {
  return {
    async acquire(): Promise<never> {
      throw err;
    },
    stats: () => ({ booted: 0 }),
    async closeAll() {},
  };
}

function installReactDom(root: string): void {
  const pkgDir = path.join(root, "node_modules", "react-dom");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-dom", version: "19.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");
  fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};");
}

describe("M90: stylesheet decision survives a buildAndServe throw", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m90-cssfail-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "Button.tsx"),
      "export default function Button() { return null; }\n",
    );
    installReactDom(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends the stylesheet decision line (layer: none) to an Error-shaped crash", async () => {
    let thrown: Error | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(new Error("EADDRINUSE: port in use")),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("Warnings recorded before this failure:");
    expect(thrown!.message).toContain("Stylesheets: none found");
  });

  it("appends the same line even when the thrown value is not an Error instance", async () => {
    let thrown: Error | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows({ message: "raw bundler failure", toString: () => "raw bundler failure" }),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toContain("Warnings recorded before this failure:");
    expect(thrown!.message).toContain("Stylesheets:");
  });

  it("appends the same line for a plain string throw", async () => {
    let thrown: Error | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows("bare string failure"),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toContain("bare string failure");
    expect(thrown!.message).toContain("Warnings recorded before this failure:");
    expect(thrown!.message).toContain("Stylesheets:");
  });

  it("names the real discovered stylesheet with the exact formatted decision line, not just 'none'", async () => {
    fs.writeFileSync(path.join(tmpDir, "globals.css"), "body { margin: 0; }\n");
    let thrown: Error | undefined;
    try {
      await analyze(path.join(tmpDir, "Button.tsx"), {
        serverPool: poolThatThrows(new Error("EADDRINUSE: port in use")),
      });
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    // Precise, not just "mentions the filename somewhere": the exact
    // formatStylesheetsLine text (the actual "Stylesheets:"-prefixed
    // decision line, distinct from the pre-existing fallback caveat
    // warning), proving this is the M90 mechanism.
    expect(thrown!.message).toContain(
      formatStylesheetsLine({
        files: ["globals.css"],
        autoDetected: true,
        layer: "largest-fallback",
        onlyCandidate: true,
        noEntryInPackage: true,
      }),
    );
  });
});

describe("M90: formatStylesheetsLine matches across every layer (invariant)", () => {
  const cases: CssReport[] = [
    { files: ["a.css"], autoDetected: false, layer: "explicit" },
    { files: ["a.css"], autoDetected: true, layer: "entry-chain" },
    { files: ["a.css"], autoDetected: true, layer: "known-name" },
    { files: ["a.css"], autoDetected: true, layer: "largest-fallback" },
    { files: [], autoDetected: false, layer: "runtime", runtimeEngines: ["@emotion/react"] },
    { files: [], autoDetected: false, layer: "disabled" },
    { files: [], autoDetected: false, layer: "none" },
  ];

  it.each(cases)("produces a non-empty, deterministic line for layer=$layer", (css) => {
    const line = formatStylesheetsLine(css);
    expect(line.length).toBeGreaterThan(0);
    expect(line).toBe(formatStylesheetsLine(css));
  });
});
