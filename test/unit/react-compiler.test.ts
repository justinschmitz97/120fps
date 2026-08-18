import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectReactCompiler,
  loadReactCompilerPlugin,
  reactCompilerResolutionWarning,
  resolveReactCompiler,
  resolveReactCompilerState,
  REACT_COMPILER_DISABLED_WARNING,
  REACT_COMPILER_PACKAGE,
} from "../../src/harness.js";
import { hasReactWarning, type ReactOptimizations } from "../../src/react-profiler.js";
import { buildEnvFingerprint, classifyEnv } from "../../src/budget.js";
import {
  DEFAULT_THRESHOLDS,
  formatTable,
  type ReactCompilerReport,
  type Report,
} from "../../src/report.js";
import {
  KNOWN_FLAGS,
  helpText,
  parseArgs,
  resolveReactCompilerFlag,
} from "../../src/cli.js";
import { withProductionResolution } from "../node-resolution.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-compiler-test-"));
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

// A resolvable stand-in package inside the project's own node_modules, so
// resolution can be observed without depending on what 120fps itself installs.
function installStub(
  options: { version?: string | null; name?: string; dir?: string } = {},
): string {
  const root = options.dir ?? tmpDir;
  const pkgDir = path.join(root, "node_modules", REACT_COMPILER_PACKAGE);
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  const manifest: Record<string, unknown> = {
    name: options.name ?? REACT_COMPILER_PACKAGE,
    main: "dist/index.cjs",
  };
  if (options.version !== null) manifest.version = options.version ?? "9.9.9";
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pkgDir, "dist", "index.cjs"), "module.exports = {};\n");
  return path.join(pkgDir, "dist", "index.cjs");
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

function optimizations(overrides: Partial<ReactOptimizations> = {}): ReactOptimizations {
  return { memoBailout: false, contextFanOut: false, ...overrides };
}

// --- K1 detection ---

describe("detectReactCompiler", () => {
  it("names the package the contract keys on", () => {
    expect(REACT_COMPILER_PACKAGE).toBe("babel-plugin-react-compiler");
  });

  it("is false when there is no package.json", () => {
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("is false for an unreadable project root", () => {
    expect(detectReactCompiler(path.join(tmpDir, "nope"))).toBe(false);
  });

  it("is false for malformed JSON", () => {
    writePkg("{ not json");
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("is false when the package is not listed", () => {
    writePkg({ dependencies: { react: "19" }, devDependencies: { vite: "6" } });
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("is true when listed in dependencies", () => {
    writePkg({ dependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    expect(detectReactCompiler(tmpDir)).toBe(true);
  });

  it("is true when listed in devDependencies", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    expect(detectReactCompiler(tmpDir)).toBe(true);
  });

  it("is true when listed in peerDependencies", () => {
    writePkg({ peerDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    expect(detectReactCompiler(tmpDir)).toBe(true);
  });

  it("ignores sections that are not objects", () => {
    writePkg({ dependencies: REACT_COMPILER_PACKAGE, devDependencies: [REACT_COMPILER_PACKAGE] });
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("still reads later sections when an earlier one is not an object", () => {
    writePkg({
      dependencies: "broken",
      devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" },
    });
    expect(detectReactCompiler(tmpDir)).toBe(true);
  });

  it("is false when package.json is not an object", () => {
    writePkg("[1,2,3]");
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });

  it("does not parse next.config for the signal", () => {
    writePkg({ dependencies: { next: "15" } });
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      "export default { experimental: { reactCompiler: true } };\n",
    );
    expect(detectReactCompiler(tmpDir)).toBe(false);
  });
});

// --- K2 resolution ---

describe("resolveReactCompiler", () => {
  it("resolves from the project's node_modules, not 120fps's", () => {
    const entry = installStub();
    const resolved = resolveReactCompiler(tmpDir);
    expect(resolved.pluginPath).toBe(fs.realpathSync(entry));
    expect(resolved.pluginPath!.startsWith(fs.realpathSync(tmpDir))).toBe(true);
  });

  it("reads the version from the resolved package", () => {
    installStub({ version: "1.2.3" });
    expect(resolveReactCompiler(tmpDir).version).toBe("1.2.3");
  });

  it("keeps the plugin path when the version is missing", () => {
    installStub({ version: null });
    const resolved = resolveReactCompiler(tmpDir);
    expect(resolved.pluginPath).toBeDefined();
    expect(resolved.version).toBeUndefined();
  });

  it("does not report a version from a package with a different name", () => {
    installStub({ name: "something-else", version: "0.0.1" });
    const resolved = resolveReactCompiler(tmpDir);
    expect(resolved.pluginPath).toBeDefined();
    expect(resolved.version).toBeUndefined();
  });

  it("returns no path when the package is absent", () => {
    expect(withProductionResolution(() => resolveReactCompiler(tmpDir))).toEqual({});
  });

  it("returns no path when the package is listed but not installed", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    expect(
      withProductionResolution(() => resolveReactCompiler(tmpDir).pluginPath),
    ).toBeUndefined();
  });

  it("returns no path when the installed package has a broken main", () => {
    const pkgDir = path.join(tmpDir, "node_modules", REACT_COMPILER_PACKAGE);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: REACT_COMPILER_PACKAGE, version: "1.0.0", main: "gone.cjs" }),
    );
    expect(resolveReactCompiler(tmpDir)).toEqual({});
  });
});

describe("loadReactCompilerPlugin", () => {
  it("returns @vitejs/plugin-react instances carrying the compiler path", async () => {
    const entry = installStub();
    const plugins = await loadReactCompilerPlugin(entry);
    expect(plugins.length).toBeGreaterThan(0);
    for (const p of plugins) {
      expect(typeof (p as { name?: unknown }).name).toBe("string");
    }
    expect(plugins.some((p) => /react/.test((p as { name: string }).name))).toBe(true);
  });
});

// --- K1 + K3 decision ---

describe("resolveReactCompilerState", () => {
  it("stays inactive when nothing is detected", () => {
    writePkg({ dependencies: { react: "19" } });
    expect(resolveReactCompilerState(tmpDir, undefined)).toEqual({
      detected: false,
      active: false,
    });
  });

  it("activates on detection when the package resolves", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    installStub({ version: "1.2.3" });
    const state = resolveReactCompilerState(tmpDir, undefined);
    expect(state.detected).toBe(true);
    expect(state.active).toBe(true);
    expect(state.version).toBe("1.2.3");
    expect(state.pluginPath).toBeDefined();
    expect(state.warning).toBeUndefined();
  });

  it("degrades with a warning when detection succeeds but resolution fails", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    const state = withProductionResolution(() =>
      resolveReactCompilerState(tmpDir, undefined),
    );
    expect(state.detected).toBe(true);
    expect(state.active).toBe(false);
    expect(state.warning).toBe(reactCompilerResolutionWarning(tmpDir));
    expect(state.pluginPath).toBeUndefined();
  });

  it("forces the transform on over a negative detection", () => {
    writePkg({ dependencies: { react: "19" } });
    installStub();
    const state = resolveReactCompilerState(tmpDir, true);
    expect(state.detected).toBe(false);
    expect(state.active).toBe(true);
  });

  it("throws the spec message when forced on and unresolvable", () => {
    writePkg({ dependencies: { react: "19" } });
    expect(() =>
      withProductionResolution(() => resolveReactCompilerState(tmpDir, true)),
    ).toThrow(`babel-plugin-react-compiler not found in ${tmpDir}`);
  });

  it("forces the transform off over a positive detection", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    installStub();
    const state = resolveReactCompilerState(tmpDir, false);
    expect(state.detected).toBe(true);
    expect(state.active).toBe(false);
    expect(state.pluginPath).toBeUndefined();
  });

  it("warns about the disabled compiler only when it was detected", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    installStub();
    expect(resolveReactCompilerState(tmpDir, false).warning).toBe(
      REACT_COMPILER_DISABLED_WARNING,
    );
  });

  it("stays silent when disabled and nothing was detected", () => {
    writePkg({ dependencies: { react: "19" } });
    expect(resolveReactCompilerState(tmpDir, false).warning).toBeUndefined();
  });

  it("uses the exact disabled-warning text from the contract", () => {
    expect(REACT_COMPILER_DISABLED_WARNING).toBe(
      "React Compiler is installed but disabled for this run; rerender costs will be higher than production.",
    );
  });

  it("names the package in the resolution warning", () => {
    expect(reactCompilerResolutionWarning(tmpDir)).toContain(REACT_COMPILER_PACKAGE);
    expect(reactCompilerResolutionWarning(tmpDir)).toContain(tmpDir);
  });

  it("never emits both warnings from one state", () => {
    writePkg({ devDependencies: { [REACT_COMPILER_PACKAGE]: "^1.0.0" } });
    const failed = withProductionResolution(() =>
      resolveReactCompilerState(tmpDir, undefined),
    );
    expect(failed.warning).not.toBe(REACT_COMPILER_DISABLED_WARNING);
    const disabled = resolveReactCompilerState(tmpDir, false);
    expect(disabled.warning).not.toBe(reactCompilerResolutionWarning(tmpDir));
  });
});

// --- K3 CLI ---

describe("--react-compiler / --no-react-compiler parsing", () => {
  it("registers both flags", () => {
    expect(KNOWN_FLAGS.has("--react-compiler")).toBe(true);
    expect(KNOWN_FLAGS.has("--no-react-compiler")).toBe(true);
  });

  it("parses --react-compiler", () => {
    const args = parseArgs(["./A.tsx", "--react-compiler"]);
    expect(args.error).toBeUndefined();
    expect(args.reactCompiler).toBe(true);
  });

  it("parses --no-react-compiler", () => {
    const args = parseArgs(["./A.tsx", "--no-react-compiler"]);
    expect(args.error).toBeUndefined();
    expect(args.noReactCompiler).toBe(true);
  });

  it("documents both flags in the help text", () => {
    const help = helpText();
    expect(help).toContain("--react-compiler");
    expect(help).toContain("--no-react-compiler");
  });

  it("maps no flag to auto-detection", () => {
    expect(resolveReactCompilerFlag(parseArgs(["./A.tsx"]))).toBeUndefined();
  });

  it("maps --react-compiler to forced on", () => {
    expect(resolveReactCompilerFlag(parseArgs(["./A.tsx", "--react-compiler"]))).toBe(true);
  });

  it("maps --no-react-compiler to forced off", () => {
    expect(resolveReactCompilerFlag(parseArgs(["./A.tsx", "--no-react-compiler"]))).toBe(
      false,
    );
  });

  it("lets --no-react-compiler win when both are given", () => {
    const args = parseArgs(["./A.tsx", "--react-compiler", "--no-react-compiler"]);
    expect(args.error).toBeUndefined();
    expect(resolveReactCompilerFlag(args)).toBe(false);
  });
});

// --- K4 React analysis reinterpretation ---

describe("hasReactWarning under an active compiler", () => {
  it("warns on a memo bailout when the compiler did not run", () => {
    expect(hasReactWarning(optimizations({ memoBailout: true }))).toBe(true);
  });

  it("does not warn on a memo bailout alone when the compiler ran", () => {
    expect(
      hasReactWarning(optimizations({ memoBailout: true, compilerActive: true })),
    ).toBe(false);
  });

  it("still warns on context fan-out when the compiler ran", () => {
    expect(
      hasReactWarning(
        optimizations({ memoBailout: true, contextFanOut: true, compilerActive: true }),
      ),
    ).toBe(true);
  });

  it("still warns on portal orphans when the compiler ran", () => {
    expect(
      hasReactWarning(
        optimizations({ memoBailout: true, portalOrphans: 2, compilerActive: true }),
      ),
    ).toBe(true);
  });

  it("still warns on callback identity pressure when the compiler ran", () => {
    expect(
      hasReactWarning(
        optimizations({
          memoBailout: true,
          compilerActive: true,
          callbackIdentityDeltas: [{ propName: "onChange", deltaMs: 3 }],
        }),
      ),
    ).toBe(true);
  });

  it("is silent with no findings at all under an active compiler", () => {
    expect(hasReactWarning(optimizations({ compilerActive: true }))).toBe(false);
  });

  it("keeps reporting the bailing components as informational", () => {
    const opts = optimizations({
      memoBailout: true,
      memoBailoutComponents: ["MemoChild"],
      compilerActive: true,
    });
    expect(hasReactWarning(opts)).toBe(false);
    expect(opts.memoBailoutComponents).toEqual(["MemoChild"]);
  });
});

// --- K5 reporting ---

describe("Report.reactCompiler", () => {
  it("renders the header line with the version when active", () => {
    const reactCompiler: ReactCompilerReport = {
      active: true,
      detected: true,
      version: "1.0.0",
    };
    expect(formatTable(makeReport({ reactCompiler }))).toContain(
      "React Compiler: active (v1.0.0)",
    );
  });

  it("renders the header line without a version when it is unknown", () => {
    const reactCompiler: ReactCompilerReport = { active: true, detected: true };
    const out = formatTable(makeReport({ reactCompiler }));
    expect(out).toContain("React Compiler: active");
    expect(out).not.toContain("(v");
  });

  it("prints no line when the transform did not run", () => {
    const reactCompiler: ReactCompilerReport = { active: false, detected: true };
    expect(formatTable(makeReport({ reactCompiler }))).not.toContain("React Compiler:");
  });

  it("prints no line when the field is absent", () => {
    expect(formatTable(makeReport())).not.toContain("React Compiler:");
  });

  it("keeps the line in the header block above the combo table", () => {
    const out = formatTable(
      makeReport({ reactCompiler: { active: true, detected: true, version: "1.0.0" } }),
    );
    expect(out.indexOf("React Compiler:")).toBeGreaterThan(out.indexOf("Machine:"));
  });

  it("renders the disabled warning through the warnings block", () => {
    const out = formatTable(
      makeReport({
        reactCompiler: { active: false, detected: true },
        warnings: [REACT_COMPILER_DISABLED_WARNING],
      }),
    );
    expect(out).toContain(REACT_COMPILER_DISABLED_WARNING);
  });
});

// --- K6 measurement continuity ---

describe("EnvFingerprint.reactCompiler", () => {
  const base = {
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

  it("records true when the transform ran", () => {
    expect(buildEnvFingerprint({ ...base, reactCompiler: true }).reactCompiler).toBe(true);
  });

  it("omits the field when the transform did not run", () => {
    expect("reactCompiler" in buildEnvFingerprint(base)).toBe(false);
  });

  it("makes a pre-compiler baseline incompatible with a compiled run", () => {
    const before = buildEnvFingerprint(base);
    const after = buildEnvFingerprint({ ...base, reactCompiler: true });
    expect(classifyEnv(before, after)).toBe("incompatible");
  });

  it("keeps two compiled runs comparable", () => {
    const a = buildEnvFingerprint({ ...base, reactCompiler: true });
    const b = buildEnvFingerprint({ ...base, reactCompiler: true });
    expect(classifyEnv(a, b)).toBe("identical");
  });

  it("keeps two pre-compiler baselines comparable", () => {
    expect(classifyEnv(buildEnvFingerprint(base), buildEnvFingerprint(base))).toBe(
      "identical",
    );
  });
});
