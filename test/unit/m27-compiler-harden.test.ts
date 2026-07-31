import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectReactCompiler,
  reactCompilerResolutionWarning,
  resolveReactCompiler,
  resolveReactCompilerState,
  REACT_COMPILER_DISABLED_WARNING,
  REACT_COMPILER_PACKAGE,
} from "../../src/harness.js";
import { hasReactWarning, type ReactOptimizations } from "../../src/react-profiler.js";
import { buildEnvFingerprint, classifyEnv } from "../../src/budget.js";
import { DEFAULT_THRESHOLDS, formatTable, type Report } from "../../src/report.js";
import { parseArgs, resolveReactCompilerFlag } from "../../src/cli.js";
import { withProductionResolution } from "../node-resolution.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-compiler-harden-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePkg(pkg: unknown, dir = tmpDir): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    typeof pkg === "string" ? pkg : JSON.stringify(pkg),
  );
}

function installStub(manifest: Record<string, unknown>, dir = tmpDir): string {
  const pkgDir = path.join(dir, "node_modules", REACT_COMPILER_PACKAGE);
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  fs.writeFileSync(path.join(pkgDir, "dist", "index.cjs"), "module.exports = {};\n");
  return pkgDir;
}

function optimizations(overrides: Partial<ReactOptimizations> = {}): ReactOptimizations {
  return { memoBailout: false, contextFanOut: false, ...overrides };
}

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

const ENV_BASE = {
  machine: {
    cpu: "Test CPU",
    cores: 8,
    ramMb: 16384,
    os: "TestOS 1.0",
    nodeVersion: "v20.0.0",
    chromiumVersion: "120.0.0",
  },
  calibration: { totalDuration: 10, scriptDuration: 5 },
  cpuThrottle: 4,
  samples: 10,
  mode: "combo" as const,
};

describe("m27 hardening — detection inputs", () => {
  it("H1: package.json holding a bare null is not trusted", () => {
    writePkg("null");
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("H2: an empty manifest is not a compiler project", () => {
    writePkg({});
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("H3: presence wins over the version range, including an empty one", () => {
    writePkg({ dependencies: { [REACT_COMPILER_PACKAGE]: "" } });
    expect(detectReactCompiler(tmpDir)).toBe(true);
  });

  it("H4: a package.json that is a directory reads as no manifest", () => {
    fs.mkdirSync(path.join(tmpDir, "package.json"));
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("H5: a BOM-prefixed manifest degrades to undetected rather than throwing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      "﻿" + JSON.stringify({ dependencies: { [REACT_COMPILER_PACKAGE]: "^1" } }),
    );
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("H6: a lookalike package name does not trigger detection", () => {
    writePkg({ dependencies: { "babel-plugin-react-compiler-runtime": "^1" } });
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });
});

describe("m27 hardening — resolution edges", () => {
  it("H7: a non-string version is dropped instead of reported", () => {
    installStub({ name: REACT_COMPILER_PACKAGE, version: 123, main: "dist/index.cjs" });
    const resolved = resolveReactCompiler(tmpDir);
    expect(resolved.pluginPath).toBeDefined();
    expect(resolved.version).toBeUndefined();
  });

  it("H8: a malformed manifest inside the package makes it unresolvable", () => {
    installStub("{ not json" as unknown as Record<string, unknown>);
    expect(resolveReactCompiler(tmpDir)).toEqual({});
  });

  it("H9: the nearest installation wins over one further up the tree", () => {
    installStub({ name: REACT_COMPILER_PACKAGE, version: "1.0.0", main: "dist/index.cjs" });
    const nested = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    installStub(
      { name: REACT_COMPILER_PACKAGE, version: "2.0.0", main: "dist/index.cjs" },
      nested,
    );
    expect(resolveReactCompiler(nested).version).toBe("2.0.0");
  });

  it("H10: an unreadable project root resolves to nothing", () => {
    expect(
      withProductionResolution(() => resolveReactCompiler(path.join(tmpDir, "gone"))),
    ).toEqual({});
  });
});

describe("m27 hardening — state transitions", () => {
  it("H11: a forced-off run never attempts resolution, so only the disabled note fires", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    installStub({ name: REACT_COMPILER_PACKAGE, version: "1.0.0", main: "missing.cjs" });
    const state = resolveReactCompilerState(tmpDir, false);
    expect(state).toEqual({
      detected: true,
      active: false,
      warning: REACT_COMPILER_DISABLED_WARNING,
    });
  });

  it("H12: a broken install degrades with the resolution note, not the disabled note", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    installStub({ name: REACT_COMPILER_PACKAGE, version: "1.0.0", main: "missing.cjs" });
    expect(resolveReactCompilerState(tmpDir, undefined).warning).toBe(
      reactCompilerResolutionWarning(tmpDir),
    );
  });

  it("H13: a broken install with the flag forced on fails the run", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    installStub({ name: REACT_COMPILER_PACKAGE, version: "1.0.0", main: "missing.cjs" });
    expect(() => resolveReactCompilerState(tmpDir, true)).toThrow(
      `${REACT_COMPILER_PACKAGE} not found in ${tmpDir}`,
    );
  });

  it("H14: a resolvable but undeclared compiler stays inactive without a flag", () => {
    writePkg({ dependencies: { react: "19" } });
    installStub({ name: REACT_COMPILER_PACKAGE, version: "1.0.0", main: "dist/index.cjs" });
    expect(resolveReactCompilerState(tmpDir, undefined)).toEqual({
      detected: false,
      active: false,
    });
  });

  it("H15: a project with no manifest at all is inactive and silent", () => {
    expect(
      withProductionResolution(() => resolveReactCompilerState(tmpDir, undefined)),
    ).toEqual({ detected: false, active: false });
  });
});

describe("m27 hardening — warning reinterpretation", () => {
  it("H16: durations-unavailable does not become a warning under the compiler", () => {
    expect(
      hasReactWarning(
        optimizations({ memoBailout: true, compilerActive: true, durationsUnavailable: true }),
      ),
    ).toBe(false);
  });

  it("H17: the callback-identity threshold keeps its 2ms boundary under the compiler", () => {
    const at = optimizations({
      compilerActive: true,
      callbackIdentityDeltas: [{ propName: "onChange", deltaMs: 2 }],
    });
    const above = optimizations({
      compilerActive: true,
      callbackIdentityDeltas: [{ propName: "onChange", deltaMs: 2.1 }],
    });
    expect(hasReactWarning(at)).toBe(false);
    expect(hasReactWarning(above)).toBe(true);
  });

  it("H18: zero portal orphans stay silent under the compiler", () => {
    expect(
      hasReactWarning(
        optimizations({ memoBailout: true, portalOrphans: 0, compilerActive: true }),
      ),
    ).toBe(false);
  });

  it("H19: an explicit compilerActive:false behaves like an uncompiled run", () => {
    expect(
      hasReactWarning(optimizations({ memoBailout: true, compilerActive: false })),
    ).toBe(true);
  });

  it("H20: the bailout list is labelled informational only under the compiler", () => {
    const combo = {
      comboIndex: 0,
      props: {},
      mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      unmount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      rerender: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      domNodeCount: 3,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.1,
      verdict: "pass" as const,
    };
    const compiled = formatTable(
      makeReport({
        combos: [
          {
            ...combo,
            reactOptimizations: optimizations({
              memoBailout: true,
              memoBailoutComponents: ["MemoChild"],
              compilerActive: true,
            }),
          },
        ],
      }),
    );
    const plain = formatTable(
      makeReport({
        combos: [
          {
            ...combo,
            reactOptimizations: optimizations({
              memoBailout: true,
              memoBailoutComponents: ["MemoChild"],
            }),
          },
        ],
      }),
    );
    expect(compiled).toContain("Memo bailout (informational, React Compiler active): MemoChild");
    expect(plain).toContain("Memo bailout: MemoChild");
    expect(plain).not.toContain("informational");
  });
});

describe("m27 hardening — reporting and continuity", () => {
  it("H21: the header block carries wrapper, stylesheet and compiler lines together", () => {
    const out = formatTable(
      makeReport({
        wrapper: { path: "120fps.setup.tsx", autoDetected: true, overheadMs: 0.1, domNodes: 0 },
        css: { files: ["app/globals.css"], autoDetected: true },
        reactCompiler: { active: true, detected: true, version: "1.0.0" },
      }),
    );
    expect(out).toContain("Wrapper: 120fps.setup.tsx");
    expect(out).toContain("Stylesheets: app/globals.css");
    expect(out).toContain("React Compiler: active (v1.0.0)");
    expect(out.indexOf("Stylesheets:")).toBeLessThan(out.indexOf("React Compiler:"));
  });

  it("H22: a compiled baseline checked against an uncompiled run is incompatible", () => {
    const compiled = buildEnvFingerprint({ ...ENV_BASE, reactCompiler: true });
    const plain = buildEnvFingerprint(ENV_BASE);
    expect(classifyEnv(compiled, plain)).toBe("incompatible");
  });

  it("H23: writing false instead of omitting would invalidate every old baseline", () => {
    const omitted = buildEnvFingerprint(ENV_BASE);
    const explicitFalse = buildEnvFingerprint({ ...ENV_BASE, reactCompiler: false });
    expect(explicitFalse.reactCompiler).toBe(false);
    expect(classifyEnv(omitted, explicitFalse)).toBe("incompatible");
  });

  it("H24: the compiler field does not disturb the other feature fields", () => {
    const a = buildEnvFingerprint({ ...ENV_BASE, css: ["a.css"], wrapper: "w.tsx", reactCompiler: true });
    const b = buildEnvFingerprint({ ...ENV_BASE, css: ["a.css"], wrapper: "w.tsx", reactCompiler: true });
    expect(classifyEnv(a, b)).toBe("identical");
  });
});

describe("m27 hardening — CLI edges", () => {
  it("H25: the equals form is rejected as an unknown flag", () => {
    expect(parseArgs(["./A.tsx", "--react-compiler=true"]).error).toMatch(/Unknown flag/);
  });

  it("H26: flag order does not change the resolved value", () => {
    const a = parseArgs(["--no-react-compiler", "./A.tsx", "--react-compiler"]);
    const b = parseArgs(["./A.tsx", "--react-compiler", "--no-react-compiler"]);
    expect(resolveReactCompilerFlag(a)).toBe(false);
    expect(resolveReactCompilerFlag(b)).toBe(false);
  });

  it("H27: the flags coexist with the other feature switches", () => {
    const args = parseArgs(["./A.tsx", "--no-css", "--react-compiler", "--no-wrap"]);
    expect(args.error).toBeUndefined();
    expect(args.noCss).toBe(true);
    expect(args.noWrap).toBe(true);
    expect(resolveReactCompilerFlag(args)).toBe(true);
  });

  it("H28: repeating a flag is idempotent", () => {
    const args = parseArgs(["./A.tsx", "--react-compiler", "--react-compiler"]);
    expect(args.error).toBeUndefined();
    expect(resolveReactCompilerFlag(args)).toBe(true);
  });
});
