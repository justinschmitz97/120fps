import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_THRESHOLDS,
  MAX_REPLAYED_WARNINGS,
  MAX_REPLAYED_WARNING_CHARS,
  MEASUREMENT_BASIS_LINE,
  VERDICT_REUSED_LINE,
  buildEnvFingerprint,
  formatTable,
  saveBaseline,
  type BaselineEntry,
  type ComboReport,
  type Report,
} from "../../src/report/index.js";
import {
  BASELINE_MODE_MISMATCH_NOTICE,
  collectMachineInfo,
  describeStoredMode,
  tryReuseStoredVerdict,
} from "../../src/pipeline/verdict-reuse.js";
import type { BrowserPool } from "../../src/browser/index.js";
import type { AnalyzeOptions } from "../../src/pipeline/analyze.js";

const CHROMIUM = "120.0.0.0";
const PROJECT = path.join(os.tmpdir(), `120fps-reuse-${process.pid}`);
const COMPONENT = path.join(PROJECT, "card.tsx");
const BASELINE_PATH = path.join(PROJECT, "120fps-baseline.json");
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
const STORED_WARNING =
  "src/theme.css was injected and none of its rules matched an element inside the component's tree.";

const pool = {
  acquire: async () => ({ version: () => CHROMIUM }),
  stats: () => ({ launched: 0 }),
  closeAll: async () => {},
} as unknown as BrowserPool;

function storedEntry(mode: "combo" | "curve", warnings?: string[]): BaselineEntry {
  const machine = {
    cpu: "stub", cores: 8, ramMb: 16384, os: "stub-os",
    nodeVersion: process.version, chromiumVersion: CHROMIUM,
  };
  return {
    mount: 4,
    rerender: 2,
    unmount: 1,
    domNodeCount: 6,
    interactions: {},
    tier: "T1",
    env: buildEnvFingerprint({
      machine,
      calibration: { totalDuration: 0, scriptDuration: 0 },
      cpuThrottle: 4,
      samples: 3,
      mode,
      framework: "react",
    }),
    sourceFingerprint: "source-fingerprint",
    pass: true,
    ...(warnings ? { warnings } : {}),
  };
}

// The stored env must carry this machine's own identity, or no entry is ever a candidate.
async function realStoredEntry(mode: "combo" | "curve", warnings?: string[]): Promise<BaselineEntry> {
  const machine = await collectMachineInfo(CHROMIUM);
  return {
    ...storedEntry(mode, warnings),
    env: buildEnvFingerprint({
      machine,
      calibration: { totalDuration: 0, scriptDuration: 0 },
      cpuThrottle: 4,
      samples: 3,
      mode,
      framework: "react",
    }),
  };
}

function reuse(extra: Partial<AnalyzeOptions> = {}): Promise<Report | undefined> {
  return tryReuseStoredVerdict({
    options: {
      check: true,
      jsonPath: path.join(PROJECT, "report.json"),
      ...extra,
    } as AnalyzeOptions,
    pool,
    projectRoot: PROJECT,
    relativeComponent: "./card.tsx",
    componentPath: COMPONENT,
    metadataPath: COMPONENT,
    thresholds: DEFAULT_THRESHOLDS,
    samples: 3,
    cpuThrottle: 4,
    framework: "react",
    getSourceFingerprint: async () => "source-fingerprint",
  });
}

beforeAll(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT, "package.json"),
    JSON.stringify({ name: "reuse-fixture", version: "0.0.0", private: true }),
    "utf-8",
  );
  fs.writeFileSync(
    COMPONENT,
    'export function Card() {\n  return null;\n}\n',
    "utf-8",
  );
});

afterAll(() => {
  fs.rmSync(PROJECT, { recursive: true, force: true });
});

const machine = {
  cpu: "Test CPU", cores: 8, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: CHROMIUM,
};

function combo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [4], median: 4, p95: 4, cv: 0, unstable: false },
    unmount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
    rerender: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    domNodeCount: 6,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.4,
    verdict: "pass",
    tier: "T1",
    ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine,
    componentPath: "src/App.tsx",
    componentName: "App",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [combo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

const REUSED = report({
  combos: [],
  cached: true,
  baseline: {
    hasBaseline: true,
    regressions: [],
    improvements: [],
    missingInteractions: [],
    envMatch: "identical",
    envMismatches: [],
  },
});

describe("a reused verdict describes only the reuse", () => {
  it("names that the verdict was reused and that nothing was re-measured", () => {
    const text = formatTable(REUSED);
    expect(text).toContain(VERDICT_REUSED_LINE);
    expect(VERDICT_REUSED_LINE.toLowerCase()).toContain("reused from baseline");
    expect(VERDICT_REUSED_LINE.toLowerCase()).toContain("nothing re-measured");
  });

  it("prints no baseline comparison for a measurement it did not take", () => {
    const text = formatTable(REUSED);
    expect(text).not.toContain("Baseline comparison");
    expect(text).not.toContain("within tolerance");
  });

  it("prints no environment-match line", () => {
    expect(formatTable(REUSED)).not.toContain("Environment:");
  });

  it("prints no interaction count", () => {
    const text = formatTable(REUSED);
    expect(text).not.toContain("Interactions");
    expect(text).not.toContain("0 interactions found");
  });

  it("counts nothing it did not measure, whatever the replayed warnings say", () => {
    const text = formatTable({
      ...REUSED,
      warnings: ["measured 8 of 32 prop combos (--max-combos raises the cap)"],
    });
    expect(text).not.toMatch(/\d+ measured/);
    expect(text).not.toContain("Mode:");
  });

  it("does not explain how numbers were measured when none were", () => {
    expect(formatTable(REUSED)).not.toContain(MEASUREMENT_BASIS_LINE);
  });

  it("still names the mode and the measurement basis for a run that measured", () => {
    const text = formatTable(report());
    expect(text).toContain("Mode:");
    expect(text).toContain(MEASUREMENT_BASIS_LINE);
  });

  it("still prints the verdict it reused", () => {
    expect(formatTable(REUSED)).toContain("Result: PASS");
    expect(formatTable({ ...REUSED, pass: false })).toContain("Result: FAIL");
  });

  it("keeps the warnings it carries", () => {
    const text = formatTable({ ...REUSED, warnings: [STORED_WARNING] });
    expect(text).toContain(STORED_WARNING);
  });
});

describe("the fixture hint fires only for a run that measured", () => {
  it("fires when a measured component exposed no interaction", () => {
    const text = formatTable(report());
    expect(text).toContain("0 interactions found");
  });

  it("never fires on a reused report", () => {
    expect(formatTable(REUSED)).not.toContain("Consider creating");
  });

  it("suggests a path with forward slashes on every platform", () => {
    const text = formatTable(report());
    const hint = text.split("\n").find((line) => line.includes("Consider creating"))!;
    expect(hint).not.toContain("\\");
    expect(hint).toContain("src/App.fixture.tsx");
  });
});

describe("a stored verdict is reused with what came with it", () => {
  it("carries the warnings of the run it reuses", async () => {
    const entry = await realStoredEntry("combo", [STORED_WARNING]);
    saveBaseline(BASELINE_PATH, entry, "./card.tsx");
    const reused = await reuse();
    expect(reused?.cached).toBe(true);
    expect(reused?.warnings).toEqual([STORED_WARNING]);
  });

  it("names the stored mode and its own before re-measuring a curve entry", async () => {
    const entry = await realStoredEntry("curve");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(BASELINE_PATH, entry, "./card.tsx");
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const reused = await reuse();
      expect(reused).toBeUndefined();
      const notice = written.join("");
      expect(notice).toContain("curve");
      expect(notice).toContain("combo");
      expect(notice).toContain(BASELINE_MODE_MISMATCH_NOTICE("curve", "combo"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a hand-edited baseline cannot break the reuse path", () => {
  it("ignores a warnings field that is not a list", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(BASELINE_PATH, { ...entry, warnings: "oops" as unknown as string[] }, "./card.tsx");
    const reused = await reuse();
    expect(reused?.cached).toBe(true);
    expect(reused?.warnings).toBeUndefined();
  });

  it("keeps only the strings out of a mixed warnings list", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    const mixed = [STORED_WARNING, 7, null] as unknown as string[];
    saveBaseline(BASELINE_PATH, { ...entry, warnings: mixed }, "./card.tsx");
    const reused = await reuse();
    expect(reused?.warnings).toEqual([STORED_WARNING]);
  });

  it("still discloses the measured scene of an entry saved without warnings", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(BASELINE_PATH, { ...entry, measuredState: "animating" }, "./card.tsx");
    const reused = await reuse();
    expect(reused?.warnings?.length).toBe(1);
    expect(reused?.warnings?.[0]).toContain("animating");
  });

  it("names an isolation entry's mode too, not only curve", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(
      BASELINE_PATH,
      { ...entry, env: { ...entry.env!, mode: "isolation" } },
      "./card.tsx",
    );
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(await reuse()).toBeUndefined();
      expect(written.join("")).toContain(BASELINE_MODE_MISMATCH_NOTICE("isolation", "combo"));
    } finally {
      spy.mockRestore();
    }
  });

  it("says nothing about modes when the source changed, which explains itself", async () => {
    const entry = await realStoredEntry("curve");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(BASELINE_PATH, { ...entry, sourceFingerprint: "other" }, "./card.tsx");
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(await reuse()).toBeUndefined();
      expect(written.join("")).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a suggested fixture path is pasteable wherever it was measured", () => {
  it("rewrites a Windows-shaped component path", () => {
    const text = formatTable(report({ componentPath: "src\\ui\\App.tsx" }));
    const hint = text.split("\n").find((line) => line.includes("Consider creating"))!;
    expect(hint).toContain("src/ui/App.fixture.tsx");
    expect(hint).not.toContain("\\");
  });

  it("suggests a .vue fixture for a Vue component with the same separators", () => {
    const text = formatTable(report({ componentPath: "src/ui/Card.vue" }));
    const hint = text.split("\n").find((line) => line.includes("Consider creating"))!;
    expect(hint).toContain("src/ui/Card.fixture.vue");
    expect(hint).not.toContain("\\");
  });
});

describe("a committed baseline cannot dictate what the terminal prints", () => {
  it("strips control characters out of a replayed warning", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    const escaped = "before" + String.fromCharCode(27) + "[31mred" + String.fromCharCode(7) + " after";
    saveBaseline(BASELINE_PATH, { ...entry, warnings: [escaped] }, "./card.tsx");
    const reused = await reuse();
    const replayed = reused?.warnings?.[0] ?? "";
    expect(replayed).not.toMatch(CONTROL_CHAR);
    expect(replayed).toContain("before");
    expect(replayed).toContain("after");
  });

  it("caps how many warnings a stored entry may replay", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    const many = Array.from({ length: MAX_REPLAYED_WARNINGS + 5 }, (_, i) => `warning ${i}`);
    saveBaseline(BASELINE_PATH, { ...entry, warnings: many }, "./card.tsx");
    const reused = await reuse();
    expect(reused?.cached).toBe(true);
    expect(reused?.warnings?.length).toBe(MAX_REPLAYED_WARNINGS);
  });

  it("caps how long one replayed warning may be", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(BASELINE_PATH, { ...entry, warnings: ["x".repeat(5000)] }, "./card.tsx");
    const reused = await reuse();
    expect(reused?.cached).toBe(true);
    expect(reused?.warnings?.[0].length).toBe(MAX_REPLAYED_WARNING_CHARS);
  });

  it("drops a warning that is only whitespace once its controls are gone", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(
      BASELINE_PATH,
      { ...entry, warnings: [String.fromCharCode(7, 7, 7), "a real one"] },
      "./card.tsx",
    );
    const reused = await reuse();
    expect(reused?.warnings).toEqual(["a real one"]);
  });

  it("refuses to name a stored mode it does not recognize", async () => {
    const entry = await realStoredEntry("combo");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(
      BASELINE_PATH,
      { ...entry, env: { ...entry.env!, mode: "</details><h1>hi" as never } },
      "./card.tsx",
    );
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(await reuse()).toBeUndefined();
      const notice = written.join("");
      expect(notice).toContain("an unknown mode");
      expect(notice).not.toContain("<h1>");
    } finally {
      spy.mockRestore();
    }
  });

  it("names only the four modes a baseline can carry", () => {
    expect(describeStoredMode("curve")).toBe("curve mode");
    expect(describeStoredMode("isolation")).toBe("isolation mode");
    expect(describeStoredMode(undefined)).toBe("an unknown mode");
    expect(describeStoredMode(7)).toBe("an unknown mode");
  });
});

describe("--baseline-file names the file the reuse check reads", () => {
  it("reuses a verdict stored at the named path, with the project root empty", async () => {
    const named = path.join(PROJECT, "elsewhere", "named-baseline.json");
    fs.rmSync(BASELINE_PATH, { force: true });
    const entry = await realStoredEntry("combo", [STORED_WARNING]);
    saveBaseline(named, entry, "./card.tsx");
    expect(fs.existsSync(BASELINE_PATH)).toBe(false);
    const reused = await reuse({ baselineFile: named });
    expect(reused?.cached).toBe(true);
    expect(reused?.warnings).toEqual([STORED_WARNING]);
  });

  it("finds nothing at the default path when the entry lives elsewhere", async () => {
    const named = path.join(PROJECT, "elsewhere", "named-baseline.json");
    fs.rmSync(BASELINE_PATH, { force: true });
    saveBaseline(named, await realStoredEntry("combo"), "./card.tsx");
    expect(await reuse()).toBeUndefined();
  });
});
