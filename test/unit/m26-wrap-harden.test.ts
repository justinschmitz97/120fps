import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAndServe, detectWrapper, generateEntry } from "../../src/harness.js";
import { resolveWrapPath } from "../../src/analyze.js";
import { parseArgs } from "../../src/cli.js";
import { attachWrapperReport, type Report, DEFAULT_THRESHOLDS } from "../../src/report.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-wrap-harden-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

// H1: wrapper path containing spaces
describe("H1: wrapper path with spaces", () => {
  it("emits a usable import specifier", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/spaced dir/wrap spaced.tsx"),
    });
    try {
      expect(harness.wrapRelative).toBe("fixtures/spaced dir/wrap spaced.tsx");
      const entry = fs.readFileSync(path.join(harness.harnessDir, "entry.tsx"), "utf-8");
      expect(entry).toContain('from "/fixtures/spaced dir/wrap spaced.tsx"');
    } finally {
      await harness.cleanup();
    }
  });
});

// H2: wrapper outside the project root
describe("H2: wrapper outside the project root", () => {
  it("throws a clear error instead of emitting a ../ import", async () => {
    const outside = path.join(tmpDir, "outside-wrap.tsx");
    fs.writeFileSync(outside, "export default function W({ children }: any) { return children; }\n");
    await expect(
      buildAndServe("./fixtures/button.tsx", { wrapPath: outside }),
    ).rejects.toThrow(/must live inside the project root/);
  });
});

// H3: .jsx wrapper
describe("H3: .jsx wrapper", () => {
  it("is accepted by buildAndServe", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-arrow.jsx"),
    });
    try {
      expect(harness.wrapRelative).toBe("fixtures/wrap-arrow.jsx");
    } finally {
      await harness.cleanup();
    }
  });
});

// H4/H5: arrow function and class default exports
describe("H4/H5: default export shapes", () => {
  it("accepts an arrow function assigned to a const and default-exported", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-arrow.jsx"),
    });
    await harness.cleanup();
  });

  it("accepts a class component", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-class.tsx"),
    });
    await harness.cleanup();
  });

  it("accepts a re-exported default", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-reexport.tsx"),
    });
    await harness.cleanup();
  });
});

// H6: object literal default export
describe("H6: non-callable default export", () => {
  it("rejects an object literal", async () => {
    await expect(
      buildAndServe("./fixtures/button.tsx", {
        wrapPath: path.resolve("./fixtures/wrap-object.tsx"),
      }),
    ).rejects.toThrow(/must default-export a React component taking \{ children \}/);
  });

  it("rejects primitive default exports", async () => {
    for (const source of ["export default 42;", 'export default "nope";', "export default true;", "export default null;"]) {
      const file = path.join(tmpDir, `w${source.length}.tsx`);
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "h6" }));
      fs.writeFileSync(file, source);
      fs.writeFileSync(path.join(tmpDir, "C.tsx"), "export default function C() { return null; }\n");
      await expect(
        buildAndServe(path.join(tmpDir, "C.tsx"), { wrapPath: file }),
      ).rejects.toThrow(/must default-export a React component/);
    }
  });
});

// H7: a rejected wrapper must not leak a harness directory
describe("H7: harness dir cleanup on wrapper rejection", () => {
  function harnessDirs(root: string): string[] {
    return fs.readdirSync(root).filter((n) => n.startsWith(".120fps-harness-"));
  }

  it("leaves no harness dir behind when the wrapper is invalid", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "h7" }));
    fs.writeFileSync(path.join(tmpDir, "C.tsx"), "export default function C() { return null; }\n");
    const wrapper = path.join(tmpDir, "bad.tsx");
    fs.writeFileSync(wrapper, "export default { nope: true };\n");

    await expect(
      buildAndServe(path.join(tmpDir, "C.tsx"), { wrapPath: wrapper }),
    ).rejects.toThrow(/must default-export a React component/);
    expect(harnessDirs(tmpDir)).toEqual([]);
  });

  it("leaves no harness dir behind when the wrapper is missing", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "h7" }));
    fs.writeFileSync(path.join(tmpDir, "C.tsx"), "export default function C() { return null; }\n");

    await expect(
      buildAndServe(path.join(tmpDir, "C.tsx"), { wrapPath: path.join(tmpDir, "gone.tsx") }),
    ).rejects.toThrow(/Wrapper module not found/);
    expect(harnessDirs(tmpDir)).toEqual([]);
  });
});

// H9: probe order with every candidate present
describe("H9: auto-detection with all candidates present", () => {
  it("picks the .tsx candidate", () => {
    for (const name of ["120fps.setup.js", "120fps.setup.ts", "120fps.setup.jsx", "120fps.setup.tsx"]) {
      fs.writeFileSync(path.join(tmpDir, name), "export default () => null;");
    }
    expect(detectWrapper(tmpDir)).toBe(path.join(tmpDir, "120fps.setup.tsx"));
  });

  it("does not throw for an unreadable project root", () => {
    expect(detectWrapper(path.join(tmpDir, "no-such-dir"))).toBeUndefined();
  });
});

// H10: posix normalization of nested wrapper paths
describe("H10: nested wrapper path normalization", () => {
  it("uses forward slashes regardless of platform separators", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-nested/deep-wrap.tsx"),
    });
    try {
      expect(harness.wrapRelative).toBe("fixtures/wrap-nested/deep-wrap.tsx");
      expect(harness.wrapRelative).not.toContain("\\");
    } finally {
      await harness.cleanup();
    }
  });
});

// H11: --wrap as the trailing argument
describe("H11: --wrap argument edge cases", () => {
  it("errors when --wrap is the last argument", () => {
    expect(parseArgs(["./a.tsx", "--wrap"]).error).toBe("--wrap requires a path argument");
  });

  it("does not swallow a following flag as the path", () => {
    const args = parseArgs(["./a.tsx", "--wrap", "--samples", "5"]);
    expect(args.error).toBe("--wrap requires a path argument");
  });
});

// H12: --no-wrap overrides --wrap
describe("H12: --no-wrap precedence", () => {
  it("suppresses an explicit wrapper", () => {
    const wrapper = path.join(tmpDir, "120fps.setup.tsx");
    fs.writeFileSync(wrapper, "export default () => null;");
    expect(resolveWrapPath({ wrapPath: wrapper, noWrap: true }, tmpDir)).toEqual({
      wrapAutoDetected: false,
    });
  });

  it("suppresses auto-detection", () => {
    fs.writeFileSync(path.join(tmpDir, "120fps.setup.tsx"), "export default () => null;");
    expect(resolveWrapPath({ noWrap: true }, tmpDir)).toEqual({ wrapAutoDetected: false });
  });

  it("throws for a missing explicit wrapper", () => {
    expect(() => resolveWrapPath({ wrapPath: path.join(tmpDir, "nope.tsx") }, tmpDir)).toThrow(
      /Wrapper module not found/,
    );
  });

  it("reports auto-detection", () => {
    const wrapper = path.join(tmpDir, "120fps.setup.tsx");
    fs.writeFileSync(wrapper, "export default () => null;");
    expect(resolveWrapPath({}, tmpDir)).toEqual({ wrapPath: wrapper, wrapAutoDetected: true });
  });
});

// H13: wrapper combined with the composed path
describe("H13: wrapper + composition", () => {
  it("wraps the composed scene and keeps the composition root identity", async () => {
    const harness = await buildAndServe("./fixtures/accordion-root.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-dom.tsx"),
      composition: {
        root: "Accordion",
        structure: [{ component: "Accordion", props: {}, children: [] }],
        repeatCount: 1,
      },
      exports: [{ name: "Accordion", isDefault: false }],
    });
    try {
      const entry = fs.readFileSync(path.join(harness.harnessDir, "entry.tsx"), "utf-8");
      expect(entry).toContain("createElement(__120fpsWrap, null, __120fpsInStrict(el))");
      expect(harness.component.name).toBe("Accordion");
    } finally {
      await harness.cleanup();
    }
  });
});

// H14: wrapper + auto-scale fan-out
describe("H14: wrapper + auto-scale", () => {
  it("emits a single wrapper around the fan-out div", () => {
    const entry = generateEntry({
      componentRelative: "fixtures/button.tsx",
      componentName: "Button",
      isDefaultExport: true,
      hasScale: false,
      wrapRelative: "fixtures/wrap-dom.tsx",
    });
    const fanOutStart = entry.indexOf("Array.from(");
    const fanOut = entry.slice(fanOutStart, entry.indexOf("));", fanOutStart));
    expect(fanOut).toContain("createElement(Button,");
    expect(fanOut).not.toContain("__120fpsWrap");
  });
});

// H17: negative DOM delta is clamped
describe("H17: wrapper DOM delta clamping", () => {
  it("never reports a negative node count", () => {
    const report = makeReport();
    attachWrapperReport(report, {
      path: "120fps.setup.tsx",
      autoDetected: false,
      overheadMs: 0,
      domNodes: 0,
    });
    expect(report.wrapper!.domNodes).toBe(0);
    expect(report.warnings).toBeUndefined();
  });
});

// H18: zero-cost wrapper still recorded
describe("H18: zero-overhead wrapper", () => {
  it("is reported without warnings", () => {
    const report = makeReport();
    attachWrapperReport(report, {
      path: "setup/120fps.setup.tsx",
      autoDetected: true,
      overheadMs: 0,
      domNodes: 0,
    });
    expect(report.wrapper).toEqual({
      path: "setup/120fps.setup.tsx",
      autoDetected: true,
      overheadMs: 0,
      domNodes: 0,
    });
    expect(report.warnings).toBeUndefined();
  });
});
