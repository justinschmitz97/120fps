import { describe, it, expect } from "vitest";
import { buildReactCompilerReport } from "../../src/analyze.js";
import {
  DEFAULT_THRESHOLDS,
  formatTable,
  type ReactCompilerReport,
  type Report,
} from "../../src/report.js";

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

describe("the React Compiler line names the React it compiled for", () => {
  it("names the version and the target together", () => {
    const reactCompiler: ReactCompilerReport = {
      active: true,
      detected: true,
      version: "1.0.0",
      target: "18",
    };
    expect(formatTable(makeReport({ reactCompiler }))).toContain(
      "React Compiler: active (v1.0.0, target 18)",
    );
  });

  it("names the target alone when the version is unknown", () => {
    const reactCompiler: ReactCompilerReport = { active: true, detected: true, target: "19" };
    expect(formatTable(makeReport({ reactCompiler }))).toContain(
      "React Compiler: active (target 19)",
    );
  });

  it("keeps the version-only wording for a report that carries no target", () => {
    const reactCompiler: ReactCompilerReport = {
      active: true,
      detected: true,
      version: "1.0.0",
    };
    expect(formatTable(makeReport({ reactCompiler }))).toContain(
      "React Compiler: active (v1.0.0)",
    );
  });
});

describe("a skipped React Compiler transform says which runtime was missing", () => {
  it("names the target and the module in one line", () => {
    const reactCompiler: ReactCompilerReport = {
      active: false,
      detected: true,
      version: "1.0.0",
      target: "18",
      skipped: { target: "18", missingModule: "react-compiler-runtime" },
    };
    const out = formatTable(makeReport({ reactCompiler }));
    expect(out).toContain(
      "React Compiler: skipped (target 18: react-compiler-runtime not installed)",
    );
    expect(out).not.toContain("React Compiler: active");
  });

  it("prints no line when the transform did not run and nothing was skipped", () => {
    const reactCompiler: ReactCompilerReport = { active: false, detected: true };
    expect(formatTable(makeReport({ reactCompiler }))).not.toContain("React Compiler:");
  });
});

describe("the report's reactCompiler object carries the harness disclosure", () => {
  it("forwards the target of an active transform", () => {
    expect(
      buildReactCompilerReport({
        detected: true,
        active: true,
        version: "1.0.0",
        target: "18",
      }),
    ).toEqual({ active: true, detected: true, version: "1.0.0", target: "18" });
  });

  it("forwards the skip reason of a transform that never ran", () => {
    expect(
      buildReactCompilerReport({
        detected: true,
        active: false,
        target: "18",
        skipped: { target: "18", missingModule: "react-compiler-runtime" },
      }),
    ).toEqual({
      active: false,
      detected: true,
      target: "18",
      skipped: { target: "18", missingModule: "react-compiler-runtime" },
    });
  });

  it("omits both fields when the harness read neither", () => {
    expect(buildReactCompilerReport({ detected: true, active: true, version: "1.0.0" })).toEqual({
      active: true,
      detected: true,
      version: "1.0.0",
    });
  });

  it("describes nothing when the compiler was neither detected nor active", () => {
    expect(buildReactCompilerReport({ detected: false, active: false })).toBeUndefined();
    expect(buildReactCompilerReport(undefined)).toBeUndefined();
  });
});
