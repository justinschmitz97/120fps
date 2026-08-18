import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanExternalDeps, SHIM_MODULES } from "../../src/harness.js";

// M62: activeShims/report.nextJsShims was always undefined because a shim
// alias's replacement resolves to a real local file, so the import got
// queued as "local" and never reached the branch that records the specifier
// for shim-usage reporting. These tests reproduce that at the
// scanExternalDeps level with a synthetic alias whose target is a real file
// on disk (mirroring dist/shims/*.js in production) — independent of
// whether the shim source is compiled, so it fails deterministically on the
// pre-fix code regardless of build state.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m62-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeComponent(imports: string) {
  const file = path.join(tmpDir, "Comp.tsx");
  fs.writeFileSync(file, `${imports}\nexport function Comp() { return null; }\n`);
  return file;
}

function writeStub(name: string) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, "export default function Stub() { return null; }\n");
  return file;
}

describe("M62: scanExternalDeps records shim-redirected specifiers", () => {
  it("records the specifier even though it resolves through a shim alias", () => {
    const shimTarget = writeStub("shim-stub.js");
    const comp = writeComponent(`import Image from "next/image";`);
    const alias = [{ find: /^next\/image$/, replacement: shimTarget, isShim: true }];

    const specs = new Set<string>();
    scanExternalDeps(comp, tmpDir, alias, specs);

    expect(specs.has("next/image")).toBe(true);
  });

  it("SHIM_MODULES ∩ importedSpecifiers is non-empty once the specifier is recorded", () => {
    const shimTarget = writeStub("shim-stub.js");
    const comp = writeComponent(`import Image from "next/image";`);
    const alias = [{ find: /^next\/image$/, replacement: shimTarget, isShim: true }];

    const specs = new Set<string>();
    scanExternalDeps(comp, tmpDir, alias, specs);

    const shimmed = SHIM_MODULES.filter((s) => specs.has(s.module)).map((s) => s.module);
    expect(shimmed).toEqual(["next/image"]);
  });

  it("still queues the shim file itself for walking (redirect keeps working)", () => {
    const shimTarget = writeStub("shim-stub.js");
    fs.writeFileSync(shimTarget, `import "left-pad";\nexport default function Stub() { return null; }\n`);
    const comp = writeComponent(`import Image from "next/image";`);
    const alias = [{ find: /^next\/image$/, replacement: shimTarget, isShim: true }];

    const specs = new Set<string>();
    const pkgs = scanExternalDeps(comp, tmpDir, alias, specs);

    // The shim's own dependency was discovered, proving the file was walked.
    expect(pkgs).toContain("left-pad");
  });

  it("does not add the shim-redirected specifier's package to externalPkgs", () => {
    const shimTarget = writeStub("shim-stub.js");
    const comp = writeComponent(`import Image from "next/image";`);
    const alias = [{ find: /^next\/image$/, replacement: shimTarget, isShim: true }];

    const pkgs = scanExternalDeps(comp, tmpDir, alias);

    expect(pkgs).not.toContain("next");
  });
});
