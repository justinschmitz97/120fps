import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAndServe,
  detectWrapper,
  generateEntry,
  generateComposedEntry,
  scanExternalDeps,
  WRAPPER_CANDIDATES,
  type HarnessResult,
} from "../../src/harness.js";
import { generateProbeEntry } from "../../src/react-profiler.js";
import { parseArgs } from "../../src/cli.js";
import {
  attachWrapperReport,
  formatTable,
  DEFAULT_THRESHOLDS,
  type Report,
  type WrapperReport,
} from "../../src/report.js";
import type { CompositionTree } from "../../src/composition.js";

// --- helpers ---

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-wrap-test-"));
});

// Deletion is deferred to the end of the file, not done per test: Vite's
// dependency optimizer keeps reading this project's node_modules after
// cleanup() returns, and removing it underneath that read is what produced the
// leaked esbuild rejection this file now guards against. Each test still gets
// its own fresh directory from beforeEach.
const finishedDirs: string[] = [];

afterEach(() => {
  finishedDirs.push(tmpDir);
});

afterAll(() => {
  for (const dir of finishedDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      cpu: "Test CPU",
      cores: 8,
      ramMb: 16384,
      os: "TestOS 1.0",
      nodeVersion: "v20.0.0",
      chromiumVersion: "120.0.0",
    },
    componentPath: "./Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [],
    thresholds: { ...DEFAULT_THRESHOLDS },
    pass: true,
    ...overrides,
  };
}

function makeWrapper(overrides: Partial<WrapperReport> = {}): WrapperReport {
  return {
    path: "120fps.setup.tsx",
    autoDetected: false,
    overheadMs: 0,
    domNodes: 0,
    ...overrides,
  };
}

const ENTRY_BASE = {
  componentRelative: "fixtures/button.tsx",
  componentName: "Button",
  isDefaultExport: true,
  hasScale: false,
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ====================================================================
// W1: resolution: CLI flags
// ====================================================================

// Every test in this file that boots a real dev server owns a temp
// node_modules that afterEach deletes. Vite's dependency optimizer runs
// detached from listen(), so a test that cleans up before the optimizer
// settles makes esbuild read a deleted file and rejects into the run — a
// rejection that leaks past the suite instead of failing a test. This guard
// turns any such leak from this file into a failure.
const leakedRejections: unknown[] = [];
const recordRejection = (reason: unknown): void => {
  leakedRejections.push(reason);
};
beforeAll(() => process.on("unhandledRejection", recordRejection));
afterAll(() => {
  process.off("unhandledRejection", recordRejection);
  expect(
    leakedRejections.map((r) => (r instanceof Error ? r.message : String(r))),
  ).toEqual([]);
});

describe("W1: --wrap / --no-wrap parsing", () => {
  it("parses --wrap with a path", () => {
    const args = parseArgs(["./Button.tsx", "--wrap", "./setup.tsx"]);
    expect(args.error).toBeUndefined();
    expect(args.wrapPath).toBe("./setup.tsx");
  });

  it("errors when --wrap has no value", () => {
    const args = parseArgs(["./Button.tsx", "--wrap"]);
    expect(args.error).toBe("--wrap requires a path argument");
  });

  it("errors when --wrap is followed by another flag", () => {
    const args = parseArgs(["./Button.tsx", "--wrap", "--ci"]);
    expect(args.error).toBe("--wrap requires a path argument");
  });

  it("parses --no-wrap", () => {
    const args = parseArgs(["./Button.tsx", "--no-wrap"]);
    expect(args.error).toBeUndefined();
    expect(args.noWrap).toBe(true);
  });

  it("accepts --wrap and --no-wrap together (no-wrap wins downstream)", () => {
    const args = parseArgs(["./Button.tsx", "--wrap", "./setup.tsx", "--no-wrap"]);
    expect(args.error).toBeUndefined();
    expect(args.wrapPath).toBe("./setup.tsx");
    expect(args.noWrap).toBe(true);
  });

  it("keeps a path with spaces intact", () => {
    const args = parseArgs(["./Button.tsx", "--wrap", "./spaced dir/setup.tsx"]);
    expect(args.wrapPath).toBe("./spaced dir/setup.tsx");
  });
});

// ====================================================================
// W1: auto-detection
// ====================================================================

describe("W1: wrapper auto-detection", () => {
  it("returns undefined when no candidate exists", () => {
    expect(detectWrapper(tmpDir)).toBeUndefined();
  });

  // M57 appends the SFC candidate; a Vue run reorders it to the front rather
  // than changing this list, so React probing order is untouched.
  it("probes candidates in tsx > jsx > ts > js > vue order", () => {
    expect(WRAPPER_CANDIDATES).toEqual([
      "120fps.setup.tsx",
      "120fps.setup.jsx",
      "120fps.setup.ts",
      "120fps.setup.js",
      "120fps.setup.vue",
    ]);
  });

  it("finds 120fps.setup.tsx", () => {
    const p = path.join(tmpDir, "120fps.setup.tsx");
    fs.writeFileSync(p, "export default () => null;");
    expect(detectWrapper(tmpDir)).toBe(p);
  });

  it("prefers .tsx over .js when both exist", () => {
    fs.writeFileSync(path.join(tmpDir, "120fps.setup.js"), "export default () => null;");
    fs.writeFileSync(path.join(tmpDir, "120fps.setup.tsx"), "export default () => null;");
    expect(detectWrapper(tmpDir)).toBe(path.join(tmpDir, "120fps.setup.tsx"));
  });

  it("prefers .jsx over .ts when both exist", () => {
    fs.writeFileSync(path.join(tmpDir, "120fps.setup.ts"), "export default () => null;");
    fs.writeFileSync(path.join(tmpDir, "120fps.setup.jsx"), "export default () => null;");
    expect(detectWrapper(tmpDir)).toBe(path.join(tmpDir, "120fps.setup.jsx"));
  });

  it("falls back to .js when it is the only candidate", () => {
    const p = path.join(tmpDir, "120fps.setup.js");
    fs.writeFileSync(p, "export default () => null;");
    expect(detectWrapper(tmpDir)).toBe(p);
  });

  it("ignores a directory named like a candidate", () => {
    fs.mkdirSync(path.join(tmpDir, "120fps.setup.tsx"));
    expect(detectWrapper(tmpDir)).toBeUndefined();
  });
});

// ====================================================================
// W3: entry generation
// ====================================================================

describe("W3: entry generation without a wrapper", () => {
  const entry = generateEntry(ENTRY_BASE);

  it("emits the plain renderTree helper", () => {
    expect(entry).toContain("const renderTree = (el: any) => root.render(__120fpsInStrict(el));");
  });

  it("never references __120fpsWrap", () => {
    expect(entry).not.toContain("__120fpsWrap");
  });

  it("routes every render through renderTree (single root.render call site)", () => {
    expect(countOccurrences(entry, "root.render(")).toBe(1);
  });

  it("exposes mountWrapperOnly", () => {
    expect(entry).toContain("mountWrapperOnly()");
  });

  it("does not expose a viewport", () => {
    expect(entry).not.toContain("viewport");
  });
});

describe("W3: entry generation with a wrapper", () => {
  const entry = generateEntry({ ...ENTRY_BASE, wrapRelative: "120fps.setup.tsx" });

  it("imports the wrapper after the react imports and before the component import", () => {
    const reactIdx = entry.indexOf('from "react-dom/client"');
    const wrapIdx = entry.indexOf('__120fpsWrap, * as __120fpsWrapModule from "/120fps.setup.tsx"');
    const componentIdx = entry.indexOf('from "/fixtures/button.tsx"');
    expect(reactIdx).toBeGreaterThan(-1);
    expect(wrapIdx).toBeGreaterThan(reactIdx);
    expect(componentIdx).toBeGreaterThan(wrapIdx);
  });

  it("emits the wrapping renderTree helper exactly once", () => {
    expect(countOccurrences(entry, "const renderTree =")).toBe(1);
    expect(entry).toContain(
      "const renderTree = (el: any) => root.render(__120fpsWrap ? createElement(__120fpsWrap, null, __120fpsInStrict(el)) : __120fpsInStrict(el));",
    );
  });

  it("routes every render through renderTree (single root.render call site)", () => {
    expect(countOccurrences(entry, "root.render(")).toBe(1);
  });

  it("re-exposes the wrapper viewport on __120fps", () => {
    expect(entry).toContain("(__120fpsWrapModule as any).viewport");
    expect(entry).toContain("(window as any).__120fps.viewport = __120fpsViewport");
  });

  it("wraps the auto-scale fan-out once, not per instance", () => {
    expect(countOccurrences(entry, "createElement(__120fpsWrap")).toBe(1);
    expect(entry).toContain('renderTree(createElement("div", null,');
  });

  it("mountWrapperOnly renders the wrapper with null children", () => {
    expect(entry).toContain("renderTree(null)");
  });
});

describe("W3: entry generation with a scale export", () => {
  const entry = generateEntry({ ...ENTRY_BASE, hasScale: true, wrapRelative: "120fps.setup.tsx" });

  it("routes the scale render through renderTree", () => {
    expect(entry).toContain("renderTree(__120fps_scale(props.__120fps_scaleN))");
    expect(countOccurrences(entry, "root.render(")).toBe(1);
  });
});

describe("W3: composed entry generation", () => {
  const tree: CompositionTree = {
    root: "Accordion",
    structure: [
      { component: "Accordion", props: {}, children: [{ component: "AccordionItem", props: {}, children: [] }] },
    ],
    repeatCount: 1,
  };

  it("emits the plain helper without a wrapper", () => {
    const entry = generateComposedEntry("fixtures/accordion-root.tsx", tree);
    expect(entry).toContain("const renderTree = (el: any) => root.render(__120fpsInStrict(el));");
    expect(entry).not.toContain("__120fpsWrap");
    expect(countOccurrences(entry, "root.render(")).toBe(1);
  });

  it("wraps the composed scene when a wrapper is active", () => {
    const entry = generateComposedEntry("fixtures/accordion-root.tsx", tree, undefined, "120fps.setup.tsx");
    expect(entry).toContain(
      "const renderTree = (el: any) => root.render(__120fpsWrap ? createElement(__120fpsWrap, null, __120fpsInStrict(el)) : __120fpsInStrict(el));",
    );
    expect(entry).toContain("renderTree(<ComposedScene {...props} />)");
    expect(countOccurrences(entry, "root.render(")).toBe(1);
    expect(countOccurrences(entry, "createElement(__120fpsWrap")).toBe(1);
  });

  it("imports the wrapper before the component import", () => {
    const entry = generateComposedEntry("fixtures/accordion-root.tsx", tree, undefined, "120fps.setup.tsx");
    const wrapIdx = entry.indexOf('from "/120fps.setup.tsx"');
    const componentIdx = entry.indexOf('from "/fixtures/accordion-root.tsx"');
    expect(wrapIdx).toBeGreaterThan(-1);
    expect(componentIdx).toBeGreaterThan(wrapIdx);
  });

  it("exposes mountWrapperOnly", () => {
    const entry = generateComposedEntry("fixtures/accordion-root.tsx", tree, undefined, "120fps.setup.tsx");
    expect(entry).toContain("mountWrapperOnly()");
    expect(entry).toContain("renderTree(null)");
  });
});

// ====================================================================
// W2 / W3: buildAndServe integration
// ====================================================================

describe("W2/W3: buildAndServe wrapper handling", () => {
  it("rejects a wrapper module without a default export", async () => {
    await expect(
      buildAndServe("./fixtures/button.tsx", {
        wrapPath: path.resolve("./fixtures/wrap-no-default.tsx"),
      }),
    ).rejects.toThrow(/must default-export a React component taking \{ children \}/);
  });

  it("rejects a missing wrapper module", async () => {
    await expect(
      buildAndServe("./fixtures/button.tsx", {
        wrapPath: path.resolve("./fixtures/does-not-exist.tsx"),
      }),
    ).rejects.toThrow(/Wrapper module not found/);
  });

  it("records wrapPath and wrapRelative on the harness", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-basic.tsx"),
    });
    try {
      expect(harness.wrapPath).toBe(path.resolve("./fixtures/wrap-basic.tsx"));
      expect(harness.wrapRelative).toBe("fixtures/wrap-basic.tsx");
      const entry = fs.readFileSync(path.join(harness.harnessDir, "entry.tsx"), "utf-8");
      expect(entry).toContain('from "/fixtures/wrap-basic.tsx"');
    } finally {
      await harness.cleanup();
    }
  });

  it("leaves wrapPath undefined when no wrapper is given", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    try {
      expect(harness.wrapPath).toBeUndefined();
      expect(harness.wrapRelative).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });
});

// ====================================================================
// W5: dependency scanning
// ====================================================================

describe("W5: wrapper deps join optimizeDeps.include", () => {
  // M73: buildAndServe refuses a React project whose react-dom has no client
  // entry, so a project booting a real server owns a resolvable one.
  function installReactDom(): void {
    const pkgDir = path.join(tmpDir, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "react-dom", version: "19.0.0", main: "index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");
    fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};");
  }

  function writeProject(): { component: string; wrapper: string } {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "wrap-scan" }));
    const component = path.join(tmpDir, "Comp.tsx");
    fs.writeFileSync(
      component,
      'import React from "react";\nimport { a } from "component-only-pkg";\nexport default function Comp() { return <div>{a}</div>; }\n',
    );
    const wrapper = path.join(tmpDir, "120fps.setup.tsx");
    fs.writeFileSync(
      wrapper,
      'import { Provider } from "wrapper-only-pkg";\nexport default function Wrap({ children }: any) { return <Provider>{children}</Provider>; }\n',
    );
    return { component, wrapper };
  }

  it("scans the wrapper module in addition to the component", () => {
    const { component, wrapper } = writeProject();
    expect(scanExternalDeps(component, tmpDir, [])).toEqual(["component-only-pkg"]);
    expect(scanExternalDeps(wrapper, tmpDir, [])).toEqual(["wrapper-only-pkg"]);
  });

  it("includes both sets in the served optimizeDeps config", async () => {
    const { component, wrapper } = writeProject();
    installReactDom();
    const harness = await buildAndServe(component, { wrapPath: wrapper });
    try {
      const include = harness.server.config.optimizeDeps.include ?? [];
      expect(include).toContain("component-only-pkg");
      expect(include).toContain("wrapper-only-pkg");
    } finally {
      // Vite's dependency optimizer is fire-and-forget by design (it must not
      // block listen()), and this project's node_modules is a temp directory
      // afterEach deletes. Letting the optimizer settle first is what keeps its
      // esbuild pass from reading a file that has just been removed and
      // rejecting into the run — the same detached surface M94's
      // resolveFatalProcessError exists for in production.
      await harness.server.waitForRequestsIdle();
      await harness.cleanup();
    }
  });

  it("resolves aliased wrapper imports and follows their transitive deps", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "wrap-alias" }));
    installReactDom();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@ui/*": ["./ui/*"] } } }),
    );
    fs.mkdirSync(path.join(tmpDir, "ui"));
    fs.writeFileSync(
      path.join(tmpDir, "ui", "theme.ts"),
      'import { tokens } from "theme-pkg";\nexport const theme = tokens;\n',
    );
    const component = path.join(tmpDir, "Comp.tsx");
    fs.writeFileSync(component, "export default function Comp() { return null; }\n");
    const wrapper = path.join(tmpDir, "120fps.setup.tsx");
    fs.writeFileSync(
      wrapper,
      'import { theme } from "@ui/theme";\nexport default function Wrap({ children }: any) { return children ?? theme; }\n',
    );

    const harness = await buildAndServe(component, { wrapPath: wrapper });
    try {
      const include = harness.server.config.optimizeDeps.include ?? [];
      // Without aliases in the wrapper scan, "@ui/theme" would be treated as an
      // external package and "theme-pkg" would never be discovered.
      expect(include).not.toContain("@ui/theme");
      expect(include).toContain("theme-pkg");
    } finally {
      await harness.server.waitForRequestsIdle();
      await harness.cleanup();
    }
  });
});

// ====================================================================
// W6: React analysis compatibility
// ====================================================================

describe("W6: component identity on HarnessResult", () => {
  it("records the component, not the wrapper, when a wrapper import comes first", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-basic.tsx"),
    });
    try {
      const entry = fs.readFileSync(path.join(harness.harnessDir, "entry.tsx"), "utf-8");
      // The wrapper is the first `from "/…"` import: the deleted regex would
      // have picked it up as the component.
      expect(entry.match(/from\s+"\/([^"]+)"/)?.[1]).toBe("fixtures/wrap-basic.tsx");
      expect(harness.component.relative).toBe("fixtures/button.tsx");
      expect(harness.component.name).toBe("Button");
      expect(harness.component.isDefaultExport).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("records a named export identity", async () => {
    const harness = await buildAndServe("./fixtures/counter.tsx");
    try {
      expect(harness.component.relative).toBe("fixtures/counter.tsx");
      expect(harness.component.isDefaultExport).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("records the composition root on the composed path", async () => {
    const tree: CompositionTree = {
      root: "Accordion",
      structure: [
        {
          component: "Accordion",
          props: {},
          children: [{ component: "AccordionItem", props: {}, children: [] }],
        },
      ],
      repeatCount: 1,
    };
    const harness = await buildAndServe("./fixtures/accordion-root.tsx", {
      composition: tree,
      exports: [
        { name: "Accordion", isDefault: false },
        { name: "AccordionItem", isDefault: false },
      ],
    });
    try {
      expect(harness.component.name).toBe("Accordion");
      expect(harness.component.isDefaultExport).toBe(false);
      expect(harness.component.relative).toBe("fixtures/accordion-root.tsx");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("W6: probe entry wrapping", () => {
  const base = {
    componentRelative: "fixtures/needs-context.tsx",
    componentName: "NeedsContext",
    isDefaultExport: true,
  };

  it("emits the plain helper without a wrapper", () => {
    const probe = generateProbeEntry(base);
    expect(probe).not.toContain("__120fpsWrap");
    expect(probe).toContain("const renderTree = (el: any) => root.render(el);");
    expect(countOccurrences(probe, "root.render(")).toBe(1);
  });

  it("wraps outside the context probe", () => {
    const probe = generateProbeEntry({ ...base, wrapRelative: "120fps.setup.tsx" });
    const wrapIdx = probe.indexOf("createElement(__120fpsWrap");
    const probeIdx = probe.indexOf("createElement(__120fpsContextProbe");
    expect(wrapIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(wrapIdx);
    expect(countOccurrences(probe, "root.render(")).toBe(1);
  });

  it("imports the wrapper before the component import", () => {
    const probe = generateProbeEntry({ ...base, wrapRelative: "120fps.setup.tsx" });
    const reactIdx = probe.indexOf('from "react-dom/client"');
    const wrapIdx = probe.indexOf('from "/120fps.setup.tsx"');
    const componentIdx = probe.indexOf('from "/fixtures/needs-context.tsx"');
    expect(wrapIdx).toBeGreaterThan(reactIdx);
    expect(componentIdx).toBeGreaterThan(wrapIdx);
  });
});

// ====================================================================
// W7: reporting
// ====================================================================

describe("W7: wrapper report shape and warnings", () => {
  it("attaches the wrapper block to the report", () => {
    const report = makeReport();
    const wrapper = makeWrapper({ autoDetected: true, overheadMs: 0.4 });
    attachWrapperReport(report, wrapper);
    expect(report.wrapper).toEqual(wrapper);
  });

  it("warns when overhead is at least 1ms", () => {
    const report = makeReport();
    attachWrapperReport(report, makeWrapper({ overheadMs: 2.345 }));
    expect(report.warnings).toContain(
      "Wrapper 120fps.setup.tsx adds 2.35ms to every mount measurement.",
    );
  });

  it("does not warn below the 1ms threshold", () => {
    const report = makeReport();
    attachWrapperReport(report, makeWrapper({ overheadMs: 0.99 }));
    expect(report.warnings ?? []).toEqual([]);
  });

  it("warns exactly at the 1ms threshold", () => {
    const report = makeReport();
    attachWrapperReport(report, makeWrapper({ overheadMs: 1 }));
    expect(report.warnings?.[0]).toContain("adds 1.00ms");
  });

  it("warns when the wrapper renders DOM nodes", () => {
    const report = makeReport();
    attachWrapperReport(report, makeWrapper({ domNodes: 2 }));
    expect(report.warnings).toContain(
      "Wrapper 120fps.setup.tsx renders 2 DOM node(s) counted in tier classification.",
    );
  });

  it("does not warn when the wrapper renders no DOM nodes", () => {
    const report = makeReport();
    attachWrapperReport(report, makeWrapper({ domNodes: 0 }));
    expect(report.warnings ?? []).toEqual([]);
  });

  it("preserves pre-existing warnings", () => {
    const report = makeReport({ warnings: ["earlier"] });
    attachWrapperReport(report, makeWrapper({ overheadMs: 3 }));
    expect(report.warnings?.[0]).toBe("earlier");
    expect(report.warnings).toHaveLength(2);
  });
});

describe("W7: formatTable header", () => {
  it("prints the wrapper path and overhead", () => {
    const report = makeReport({ wrapper: makeWrapper({ overheadMs: 1.5 }) });
    const out = formatTable(report);
    expect(out).toContain("Wrapper: 120fps.setup.tsx, +1.50ms mount overhead");
  });

  it("marks auto-detected wrappers", () => {
    const report = makeReport({ wrapper: makeWrapper({ autoDetected: true, overheadMs: 0 }) });
    expect(formatTable(report)).toContain("Wrapper: 120fps.setup.tsx (auto-detected), +0.00ms mount overhead");
  });

  it("prints no wrapper line when none is active", () => {
    expect(formatTable(makeReport())).not.toContain("Wrapper:");
  });
});
