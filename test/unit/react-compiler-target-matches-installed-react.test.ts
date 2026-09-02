import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectReactMajor,
  reactCompilerBabelOptions,
  reactCompilerRuntimeDeps,
  resolveReactCompilerState,
  REACT_COMPILER_PACKAGE,
} from "../../src/harness.js";

// primer-react-F1: the compiler ran with an empty options object, defaulted to
// React 19, emitted `import { c } from "react/compiler-runtime"`, and the
// installed React 18.3.1 answered ERR_PACKAGE_PATH_NOT_EXPORTED. The project
// passes `target: "18"` in its own babel config and installs
// react-compiler-runtime; the harness read neither.
const FIXTURES = path.resolve(import.meta.dirname, "..", "..", "fixtures");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-compiler-target-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function useFixture(name: string): void {
  fs.cpSync(path.join(FIXTURES, name), tmpDir, { recursive: true });
}

function installPackage(name: string, manifest: Record<string, unknown>, files: string[] = []): void {
  const pkgDir = path.join(tmpDir, "node_modules", ...name.split("/"));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest));
  for (const file of ["index.js", ...files]) {
    fs.mkdirSync(path.dirname(path.join(pkgDir, file)), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, file), "module.exports = {};\n");
  }
}

function installReact(version: string, files: string[] = []): void {
  installPackage("react", { name: "react", version, main: "index.js" }, files);
}

function installCompilerPlugin(): void {
  installPackage(REACT_COMPILER_PACKAGE, {
    name: REACT_COMPILER_PACKAGE,
    version: "1.0.0",
    main: "index.js",
  });
}

describe("React Compiler target", () => {
  it("reads the major of the React installed in the measured project", () => {
    useFixture("compiler-react18-project");
    installReact("18.3.1");

    expect(detectReactMajor(tmpDir)).toBe("18");
  });

  it("is 19 for a React 19 project and keeps the transform active", () => {
    useFixture("compiler-project");
    installReact("19.1.0", ["compiler-runtime.js"]);
    installCompilerPlugin();

    const state = resolveReactCompilerState(tmpDir, undefined);
    expect(state.target).toBe("19");
    expect(state.active).toBe(true);
    expect(state.skipped).toBeUndefined();
  });

  it("is 18 for a React 18 project that installs the compiler runtime", () => {
    useFixture("compiler-react18-runtime-project");
    installReact("18.3.1");
    installCompilerPlugin();
    installPackage("react-compiler-runtime", {
      name: "react-compiler-runtime",
      version: "1.0.0",
      main: "index.js",
    });

    const state = resolveReactCompilerState(tmpDir, undefined);
    expect(state.target).toBe("18");
    expect(state.active).toBe(true);
    expect(state.skipped).toBeUndefined();
  });

  it("reaches the Babel plugin as an explicit option", () => {
    expect(reactCompilerBabelOptions("18")).toEqual({ target: "18" });
  });
});

describe("React Compiler runtime that the target needs but the project lacks", () => {
  it("skips the transform instead of emitting an import that cannot resolve", () => {
    useFixture("compiler-react18-project");
    installReact("18.3.1");
    installCompilerPlugin();

    const state = resolveReactCompilerState(tmpDir, undefined);
    expect(state.active).toBe(false);
    expect(state.skipped).toEqual({ target: "18", missingModule: "react-compiler-runtime" });
  });

  it("warns with the target, the missing module and the package that supplies it", () => {
    useFixture("compiler-react18-project");
    installReact("18.3.1");
    installCompilerPlugin();

    const state = resolveReactCompilerState(tmpDir, undefined);
    expect(state.warning).toContain("target 18");
    expect(state.warning).toContain("react-compiler-runtime");
  });

  it("pre-bundles the runtime module the target actually imports", () => {
    useFixture("compiler-react18-runtime-project");
    installReact("18.3.1");
    installPackage("react-compiler-runtime", {
      name: "react-compiler-runtime",
      version: "1.0.0",
      main: "index.js",
    });

    expect(reactCompilerRuntimeDeps(tmpDir, "18")).toEqual(["react-compiler-runtime"]);
    expect(reactCompilerRuntimeDeps(tmpDir, "18")).not.toContain("react/compiler-runtime");
  });

  it("declares nothing when the runtime module does not resolve", () => {
    useFixture("compiler-react18-project");
    installReact("18.3.1");

    expect(reactCompilerRuntimeDeps(tmpDir, "18")).toEqual([]);
  });
});

// M108 review: with no readable target the plugin defaults to React 19 and the
// run discloses neither the target nor the runtime it will import.
describe("React Compiler target that cannot be read", () => {
  it("keeps the transform off for a React 16 install", () => {
    useFixture("compiler-react18-project");
    installReact("16.14.0");
    installCompilerPlugin();

    expect(detectReactMajor(tmpDir)).toBeUndefined();
    const state = resolveReactCompilerState(tmpDir, undefined);
    expect(state.active).toBe(false);
    expect(state.target).toBeUndefined();
  });

  it("warns naming the project root instead of defaulting silently to 19", () => {
    useFixture("compiler-react18-project");
    installReact("16.14.0");
    installCompilerPlugin();

    const state = resolveReactCompilerState(tmpDir, undefined);
    expect(state.warning).toContain("target is unknown");
    expect(state.warning).toContain(tmpDir);
  });

  it("falls back to the declared react range when nothing is installed", () => {
    useFixture("compiler-react18-project");
    installCompilerPlugin();

    const state = resolveReactCompilerState(tmpDir, undefined);
    expect(state.target).toBe("18");
    expect(state.warning).toBeUndefined();
  });

  it("keeps the transform off when neither the install nor the manifest names a major", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
    installCompilerPlugin();

    const state = resolveReactCompilerState(tmpDir, true);
    expect(state.active).toBe(false);
    expect(state.warning).toContain("target is unknown");
  });
});
