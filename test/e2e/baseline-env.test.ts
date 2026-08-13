import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { analyze, type AnalyzeOptions } from "../../src/analyze.js";
import { baselineKey, computeEnvKey, parseBaselineKey, type Baseline, type BaselineEntry } from "../../src/budget.js";
import type { Report } from "../../src/report.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("dist/cli.js");

// A package.json inside the repo makes this directory its own project root, so
// the baseline lands here instead of at the repo root, while node resolution
// still reaches the repo's node_modules.
const PROJECT_DIR = path.resolve(`.m29-baseline-env-${process.pid}`);
const COMPONENT = path.join(PROJECT_DIR, "static-panel.tsx");
const BASELINE = path.join(PROJECT_DIR, "120fps-baseline.json");
const ENTRY_KEY = "./static-panel.tsx";

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipAutoCompose: true,
  skipReactAnalysis: true,
};

let pristine: string;

function run(options: AnalyzeOptions): Promise<Report> {
  return analyze(COMPONENT, {
    ...FAST,
    ...options,
    jsonPath: path.join(PROJECT_DIR, "report.json"),
  });
}

function readBaseline(): Baseline {
  return JSON.parse(fs.readFileSync(BASELINE, "utf-8")) as Baseline;
}

// M45: entries live in per-environment slots, so the component's key carries an
// environment digest.
function slotKey(baseline: Baseline): string {
  const key = Object.keys(baseline.entries).find(
    (k) => parseBaselineKey(k).componentPath === ENTRY_KEY,
  );
  if (!key) throw new Error(`no baseline slot for ${ENTRY_KEY}`);
  return key;
}

function storedEntry(): BaselineEntry {
  const baseline = readBaseline();
  return baseline.entries[slotKey(baseline)];
}

// Editing the recorded environment moves the entry to the slot that environment
// describes — which is what a baseline saved on another machine looks like.
function patchBaseline(mutate: (entry: BaselineEntry) => void): void {
  const baseline = readBaseline();
  const key = slotKey(baseline);
  const entry = baseline.entries[key];
  mutate(entry);
  delete baseline.entries[key];
  baseline.entries[baselineKey(ENTRY_KEY, computeEnvKey(entry.env))] = entry;
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2), "utf-8");
}

function envWarnings(report: Report): string[] {
  return (report.warnings ?? []).filter(
    (w) => /environment|--baseline-env/i.test(w),
  );
}

beforeAll(async () => {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_DIR, "package.json"),
    JSON.stringify({ name: "m29-baseline-env-fixture", version: "0.0.0", private: true }),
    "utf-8",
  );
  fs.writeFileSync(
    COMPONENT,
    `import React from "react";

export function StaticPanel() {
  return (
    <div className="panel">
      <h2>Panel</h2>
      <p>Static content, no interactive elements.</p>
    </div>
  );
}
`,
    "utf-8",
  );

  // Other e2e files build dist too; a concurrent tsc is fine as long as the
  // binary exists afterwards.
  try {
    execFileSync("npx", ["tsc"], { cwd: path.resolve("."), shell: true, stdio: "ignore" });
  } catch (err) {
    if (!fs.existsSync(CLI_PATH)) throw err;
  }

  await run({ saveBaseline: true });
  pristine = fs.readFileSync(BASELINE, "utf-8");
}, 300000);

afterAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(BASELINE, pristine, "utf-8");
});

describe("baseline environment fingerprint e2e", () => {
  it("saves a fingerprint describing the run", () => {
    const stored = storedEntry().env!;
    expect(stored).toBeDefined();
    expect(stored.shape).toBe(1);
    expect(stored.mode).toBe("combo");
    expect(stored.samples).toBe(2);
    expect(stored.cpuThrottle).toBe(4);
    expect(stored.calibrationTotalDuration).toBeGreaterThan(0);
    expect(stored.cpu.length).toBeGreaterThan(0);
    expect(stored.cores).toBeGreaterThan(0);
    expect(stored.chromiumVersion.length).toBeGreaterThan(0);
    expect(stored.wrapper).toBeUndefined();
    expect(stored.css).toBeUndefined();
    expect(stored.reactCompiler).toBeUndefined();
  });

  // Calibration drifts with machine load, so an unchanged same-machine check is
  // identical or normalizable — never incompatible, never unfingerprinted, and
  // never a feature mismatch. Exact classification is unit-tested on the pure
  // function; this asserts the round trip carries the fingerprint through.
  it("compares an unchanged same-machine baseline without a feature mismatch or warning", async () => {
    const report = await run({ check: true });
    expect(report.baseline?.hasBaseline).toBe(true);
    expect(["identical", "normalizable"]).toContain(report.baseline?.envMatch);
    expect(report.baseline?.envMismatches.some((m) => /^(stylesheets|provider wrapper|React Compiler|mode):/.test(m))).toBe(false);
    expect(envWarnings(report)).toEqual([]);
  }, 300000);

  // M45: a different CPU is a different slot, so this is now the explicit
  // cross-environment fallback rather than the accidental default. It still
  // compares and still classifies, but it can no longer fail a run.
  it("falls back across environments for a different CPU, compares, and cannot fail", async () => {
    patchBaseline((e) => {
      e.env!.cpu = "Some Other CPU Model";
    });
    const report = await run({ check: true });
    expect(report.baseline?.envMatch).toBe("normalizable");
    expect(report.baseline?.crossEnvironment).toBe(true);
    expect(report.baseline?.envMismatches.some((m) => m.startsWith("CPU:"))).toBe(true);
    expect(envWarnings(report).join(" ")).toContain("No baseline for this environment");
  }, 300000);

  it("classifies a wrapper mismatch as incompatible, names it, and does not fail", async () => {
    patchBaseline((e) => {
      e.env!.wrapper = "120fps.setup.tsx";
    });
    const report = await run({ check: true });
    expect(report.baseline?.envMatch).toBe("incompatible");
    expect(report.baseline?.regressions).toEqual([]);
    expect(report.baseline?.envMismatches.join(" ")).toContain("120fps.setup.tsx");
    expect(envWarnings(report).join(" ")).toContain("incompatible");
  }, 300000);

  it("classifies a mode mismatch as incompatible", async () => {
    patchBaseline((e) => {
      e.env!.mode = "isolation";
    });
    const report = await run({ check: true });
    expect(report.baseline?.envMatch).toBe("incompatible");
    expect(report.baseline?.envMismatches.join(" ")).toContain("mode");
  }, 300000);

  it("compares a pre-M29 entry raw and warns", async () => {
    patchBaseline((e) => {
      delete e.env;
    });
    const report = await run({ check: true });
    expect(report.baseline?.envMatch).toBe("unknown");
    expect(envWarnings(report).join(" ")).toContain("no environment record");
  }, 300000);

  it("fails the check under --baseline-env strict when the environment drifted", async () => {
    patchBaseline((e) => {
      e.env!.cpu = "Some Other CPU Model";
    });
    const report = await run({ check: true, baselineEnv: "strict" });
    expect(report.baseline?.envMatch).toBe("normalizable");
    expect(report.pass).toBe(false);
    expect(envWarnings(report).join(" ")).toContain("--baseline-env strict");
  }, 300000);

  it("compares raw with no environment signal under --baseline-env ignore", async () => {
    patchBaseline((e) => {
      e.env!.wrapper = "120fps.setup.tsx";
      e.mount = 0.0001;
    });
    const report = await run({ check: true, baselineEnv: "ignore" });
    expect(report.baseline?.envMatch).toBe("unknown");
    expect(report.baseline?.envMismatches).toEqual([]);
    // M46 blanks deltas when the machine was hostile, which a loaded CI box can
    // be. That path has its own coverage; what this test is about is that
    // `ignore` compares raw and stays silent about the environment.
    if (report.noise?.level !== "hostile") {
      expect(report.baseline?.regressions.length).toBeGreaterThan(0);
    }
    expect(envWarnings(report)).toEqual([]);
  }, 300000);

  it("exits 1 from the CLI under --baseline-env strict", async () => {
    patchBaseline((e) => {
      e.env!.cores = e.env!.cores + 4;
    });
    let code = 0;
    try {
      await execFileAsync(
        process.execPath,
        [
          CLI_PATH,
          COMPONENT,
          "--check",
          "--baseline-env", "strict",
          "--samples", "2",
          "--ci",
          "--no-react-analysis",
          "--no-deltas",
          "--no-auto-scale",
          "--no-attribution",
          "--json", path.join(PROJECT_DIR, "cli-report.json"),
        ],
        { timeout: 280000, cwd: path.resolve(".") },
      );
    } catch (err: any) {
      code = err.status ?? err.code ?? 1;
    }
    expect(code).toBe(1);
    const cliReport = JSON.parse(
      fs.readFileSync(path.join(PROJECT_DIR, "cli-report.json"), "utf-8"),
    ) as Report;
    expect(cliReport.baseline?.envMatch).toBe("normalizable");
    expect(cliReport.pass).toBe(false);
  }, 300000);
});
