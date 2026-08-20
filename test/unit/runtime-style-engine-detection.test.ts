import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUNTIME_STYLE_ENGINES,
  detectRuntimeStyleEngines,
  discoverGlobalCss,
} from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-runtime-style-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function manifest(deps: Record<string, string>): void {
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p", dependencies: deps }));
}

function write(relative: string, body: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

describe("RUNTIME_STYLE_ENGINES", () => {
  it("lists the engines it recognizes", () => {
    expect(RUNTIME_STYLE_ENGINES).toEqual([
      "@ant-design/cssinjs",
      "@emotion/react",
      "@emotion/styled",
      "@emotion/css",
      "styled-components",
      "primevue",
    ]);
  });
});

describe("detectRuntimeStyleEngines", () => {
  it("finds none in a plain project", () => {
    manifest({ react: "^19.0.0" });
    expect(detectRuntimeStyleEngines(tmpDir)).toEqual([]);
  });

  it("names each declared engine", () => {
    manifest({ "@emotion/react": "^11.0.0", "@emotion/styled": "^11.0.0" });
    expect(detectRuntimeStyleEngines(tmpDir)).toEqual(["@emotion/react", "@emotion/styled"]);
  });

  it("finds a single declared engine", () => {
    manifest({ "@ant-design/cssinjs": "^1.0.0" });
    expect(detectRuntimeStyleEngines(tmpDir)).toEqual(["@ant-design/cssinjs"]);
  });
});

// The ant-design and chakra-ui shapes from the field test: no static
// stylesheet is ever going to exist because styling is generated live in the
// browser. This is a first-class, disclosed outcome, not silence.
describe("runtime CSS-in-JS as a discovery outcome", () => {
  it("resolves to runtime when the fallback layer has no survivor and an engine is declared (ant-design shape)", () => {
    manifest({ "@ant-design/cssinjs": "^1.0.0" });
    write("components/style/reset.css", "*{margin:0}");
    const warnings: string[] = [];
    const result = discoverGlobalCss(tmpDir, warnings);
    expect(result).toEqual({
      files: [],
      source: "runtime",
      runtimeEngines: ["@ant-design/cssinjs"],
    });
    // The disqualified reset.css is still named, even though the outcome
    // resolved to runtime rather than none.
    expect(warnings.some((w) => w.includes("reset.css"))).toBe(true);
  });

  it("resolves to none for the same project without the runtime engine declared", () => {
    manifest({});
    write("components/style/reset.css", "*{margin:0}");
    const warnings: string[] = [];
    const result = discoverGlobalCss(tmpDir, warnings);
    expect(result).toEqual({ files: [], source: "none" });
    expect(warnings.some((w) => w.includes("reset.css"))).toBe(true);
  });

  it("resolves to runtime for a project with zero stylesheets anywhere (chakra-ui shape)", () => {
    manifest({ "@emotion/react": "^11.0.0", "@emotion/styled": "^11.0.0" });
    const result = discoverGlobalCss(tmpDir);
    expect(result).toEqual({
      files: [],
      source: "runtime",
      runtimeEngines: ["@emotion/react", "@emotion/styled"],
    });
  });

  it("resolves to none for a project with zero stylesheets and no runtime engine declared", () => {
    manifest({});
    expect(discoverGlobalCss(tmpDir)).toEqual({ files: [], source: "none" });
  });

  it("never checks runtime engines when a real stylesheet was already found", () => {
    manifest({ "@emotion/react": "^11.0.0" });
    const css = write("app/globals.css", "body{margin:0}");
    expect(discoverGlobalCss(tmpDir)).toEqual({ files: [css], source: "candidate" });
  });

  it("never checks runtime engines when the largest-stylesheet fallback has a survivor", () => {
    manifest({ "@emotion/react": "^11.0.0" });
    const real = write("src/theme/tokens.css", ".a{color:red}".padEnd(50, " "));
    const result = discoverGlobalCss(tmpDir);
    expect(result.source).toBe("fallback");
    expect(result.files).toEqual([real]);
  });
});
