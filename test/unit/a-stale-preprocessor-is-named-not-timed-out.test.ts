import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { presentBundlerFailure } from "../../src/harness/index.js";

// uptime-kuma's shape: sass is installed but pinned below the API Vite calls, so no recognizer
// matched and the run waited out the whole readiness bound with nothing to read.
const STALE_SASS_REPORT = [
  "component harness did not become ready within timeout. Page errors:",
  "  - [vite] Internal Server Error",
  "[sass] sass.compileStringAsync is not a function",
  "  - response 500: GET http://localhost:5173/src/components/Tag.vue?vue&type=style&index=0&scoped=1b13cba6&lang.scss",
  "It waited 90 s for the harness page to define window.__120fps.",
].join("\n");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-stale-preprocessor-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installPackage(name: string, version: string): void {
  const dir = path.join(tmpDir, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
}

describe("a preprocessor the project pins below the API the dev server calls", () => {
  it("names the package, the installed version, the minimum and the way to run without it", () => {
    installPackage("sass", "1.42.1");

    const presented = presentBundlerFailure(STALE_SASS_REPORT, tmpDir, []);

    expect(presented).toContain("sass 1.42.1");
    expect(presented).toContain("compileStringAsync");
    expect(presented).toContain("1.45.0");
    expect(presented).toContain("--no-css");
  });

  it("names the stylesheet the dev server answered with 500", () => {
    installPackage("sass", "1.42.1");

    expect(presentBundlerFailure(STALE_SASS_REPORT, tmpDir, [])).toContain("src/components/Tag.vue");
  });

  it("keeps the readiness report and appends the diagnosis, as every other diagnosis does", () => {
    installPackage("sass", "1.42.1");

    const presented = presentBundlerFailure(STALE_SASS_REPORT, tmpDir, []);

    expect(presented.startsWith("component harness did not become ready within timeout.")).toBe(true);
    expect(presented).toContain("It waited 90 s");
  });

  it("names the API and no version when no installed preprocessor can be read", () => {
    const presented = presentBundlerFailure(STALE_SASS_REPORT, tmpDir, []);

    expect(presented).toContain("compileStringAsync");
    expect(presented).not.toMatch(/sass \d/);
  });

  it("names less when the dev server's error came from less", () => {
    installPackage("less", "3.0.0");
    const report = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "[less] render is not a function",
      "  - response 500: GET http://localhost:5173/src/theme.less",
    ].join("\n");

    const presented = presentBundlerFailure(report, tmpDir, []);

    expect(presented).toContain("less 3.0.0");
    expect(presented).toContain("render");
    expect(presented).not.toContain("1.45.0");
  });
});

describe("the preprocessor failures that already had a diagnosis", () => {
  it("still diagnoses a preprocessor Vite could not find at all", () => {
    const report = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      'Preprocessor dependency "sass-embedded" not found. Did you install it? Try `npm install -D sass-embedded`.',
      "  - response 500: GET http://localhost:5173/src/app.scss",
    ].join("\n");

    const presented = presentBundlerFailure(report, tmpDir, []);

    expect(presented).toContain("could not load");
    expect(presented).not.toContain("compileStringAsync");
  });

  it("leaves an internal server error that names no preprocessor undiagnosed", () => {
    const report = [
      "component harness did not become ready within timeout. Page errors:",
      "  - [vite] Internal Server Error",
      "TypeError: config.plugins.map is not a function",
    ].join("\n");

    expect(presentBundlerFailure(report, tmpDir, [])).toBe(report);
  });
});
