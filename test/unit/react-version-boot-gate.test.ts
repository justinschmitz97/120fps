import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertReactDomClient, REACT_DOM_CLIENT_MISSING } from "../../src/harness.js";

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

  it("still refuses when no react-dom is installed at all", () => {
    expect(() => assertReactDomClient(tmpDir)).toThrow(/React 18\+ required/);
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
