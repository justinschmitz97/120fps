import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertReactDomClient, REACT_DOM_CLIENT_MISSING } from "../../src/harness.js";
import { HARD_REMEDY } from "../../src/preflight.js";
import { withProductionResolution } from "../node-resolution.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-react-gate-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installReactDom(version: string, withClientEntry: boolean): void {
  const pkgDir = path.join(tmpDir, "node_modules", "react-dom");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "react-dom", version, main: "index.js" }),
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
  if (withClientEntry) {
    fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};\n");
  }
}

function writePackageJson(deps: Record<string, string>): void {
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: deps }));
}

function throwMessage(fn: () => void): string {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  return (thrown as Error).message;
}

describe("react-dom/client availability gate", () => {
  it("passes for a project whose react-dom exposes the client entry", () => {
    installReactDom("18.3.1", true);
    expect(() => assertReactDomClient(tmpDir)).not.toThrow();
  });

  it("names the required React version and the found react-dom version", () => {
    installReactDom("17.0.2", false);
    let thrown: unknown;
    try {
      assertReactDomClient(tmpDir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("React 18+ required");
    expect(message).toContain("react-dom v17.0.2");
    expect(message).not.toContain("esbuild");
  });

  // M78: this used to assert /React 18\+ required/ against a tmpDir with
  // zero node_modules — the excalidraw shape, and exactly the bug. The old
  // catch treated every resolution failure as "version too old"; the real
  // cause here is that nothing is installed at all. See M76-M83-MAP.md's
  // "LOCKED IN BY AN EXISTING TEST" note: an implementer who sees this test
  // fail and "fixes" the code to satisfy the old assertion restores the bug.
  it("still refuses when no react-dom is installed at all, naming the missing install (not a version claim)", () => {
    withProductionResolution(() => {
      const message = throwMessage(() => assertReactDomClient(tmpDir));
      expect(message).not.toContain("React 18+ required");
      expect(message).not.toContain("Upgrade react-dom");
      expect(message).toContain("no installed dependencies");
      expect(message).toContain(HARD_REMEDY["not-installed"]);
    });
  });
});

// M78: assertReactDomClient's bare try/catch used to collapse four distinct
// real causes into one wrong "version too old" message. Each cause below is
// reached the same way runPreflight's own not-installed/PnP checks are, so
// the gate names the truth even when reached directly (e.g. as the
// --no-preflight backstop, which never skips this function).
describe("react-dom/client resolution-failure taxonomy", () => {
  it("names Yarn PnP, not a react-dom version, when the workspace is PnP", () => {
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    withProductionResolution(() => {
      const message = throwMessage(() => assertReactDomClient(tmpDir));
      expect(message).not.toContain("React 18+ required");
      expect(message).toContain("Plug'n'Play");
      expect(message).toContain(HARD_REMEDY["yarn-pnp"]);
    });
  });

  it("names the missing dependency, not a version, when react-dom is undeclared", () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    writePackageJson({ lodash: "^4.0.0" });
    withProductionResolution(() => {
      const message = throwMessage(() => assertReactDomClient(tmpDir));
      expect(message).not.toContain("React 18+ required");
      expect(message).toContain("not a dependency of this project");
      expect(message).toContain(tmpDir);
    });
  });

  it("names Solid and reuses the unsupported-framework remedy when solid-js is declared instead", () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    writePackageJson({ "solid-js": "^1.8.0" });
    withProductionResolution(() => {
      const message = throwMessage(() => assertReactDomClient(tmpDir));
      expect(message).not.toContain("React 18+ required");
      expect(message).toContain("solid-js");
      expect(message).toContain(HARD_REMEDY["unsupported-framework"]);
    });
  });

  it("names an incomplete install, not a version, when react-dom is declared but not linked", () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    );
    writePackageJson({ "react-dom": "^18.0.0" });
    withProductionResolution(() => {
      const message = throwMessage(() => assertReactDomClient(tmpDir));
      expect(message).not.toContain("React 18+ required");
      expect(message).toContain("declared in package.json but was not found installed");
      expect(message).toContain(tmpDir);
    });
  });

  // preact-app-F5: a real, too-old react-dom is still the one true "upgrade"
  // case, now with an addendum naming preact/compat's own shim.
  it("appends the preact/compat shim note to the outdated message when preact is also declared", () => {
    installReactDom("17.0.2", false);
    writePackageJson({ "react-dom": "17.0.2", preact: "^10.19.0" });
    const message = throwMessage(() => assertReactDomClient(tmpDir));
    expect(message).toContain("React 18+ required");
    expect(message).toContain("react-dom v17.0.2");
    expect(message).toContain("preact/compat/client.js");
    expect(message).toContain("createRoot/hydrateRoot");
  });

  it("does not append the preact addendum when preact is not declared", () => {
    installReactDom("17.0.2", false);
    const message = throwMessage(() => assertReactDomClient(tmpDir));
    expect(message).not.toContain("preact");
  });
});

describe("REACT_DOM_CLIENT_MISSING message", () => {
  it("omits the version parenthetical when the version is unreadable", () => {
    const message = REACT_DOM_CLIENT_MISSING("/app", undefined);
    expect(message).toContain("React 18+ required");
    expect(message).toContain("/app");
    expect(message).not.toContain("found react-dom");
  });

  it("names createRoot as the reason the entry is required", () => {
    const message = REACT_DOM_CLIENT_MISSING("/app", "16.14.0");
    expect(message).toContain("found react-dom v16.14.0");
    expect(message).toContain("createRoot");
  });
});
