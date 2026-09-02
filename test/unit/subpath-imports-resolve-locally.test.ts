import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanExternalDeps } from "../../src/harness.js";

// epic-stack-F1: `#app/utils/misc.tsx` is a Node subpath import declared in the
// measured package's own `imports` map. Classified as a bare package it becomes
// an `optimizeDeps.include` entry for `#app`, which Vite resolves against the
// package's map, finds no `#app` key, and throws
// `Missing "#app" specifier in "epic-stack-template" package` — a failure the
// harness manufactured for a graph edge that resolves to a file on disk.
const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "fixtures", "imports-field-project");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-subpath-imports-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe("a subpath import declared in the package's own imports map", () => {
  it("never becomes an optimizeDeps entry", () => {
    const externals = scanExternalDeps(path.join(FIXTURE, "app", "Button.tsx"), FIXTURE, []);

    expect(externals.filter((e) => e.startsWith("#"))).toEqual([]);
  });

  it("is walked as a local file, so packages behind it are still discovered", () => {
    const externals = scanExternalDeps(path.join(FIXTURE, "app", "Button.tsx"), FIXTURE, []);

    expect(externals).toContain("clsx");
  });

  it("resolves an extensionless target through the map's * pattern", () => {
    write("package.json", JSON.stringify({ name: "p", imports: { "#lib/*": "./lib/*" } }));
    write("lib/format.ts", `import "date-fns";\nexport const f = () => 1;\n`);
    const entry = write("Card.tsx", `import { f } from "#lib/format";\nexport const Card = f;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toEqual(["date-fns"]);
  });

  it("reads the conditions object of an imports entry", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "p",
        imports: { "#state": { browser: "./state.browser.ts", default: "./state.node.ts" } },
      }),
    );
    write("state.browser.ts", `import "zustand";\nexport const s = 1;\n`);
    write("state.node.ts", `import "node-only-store";\nexport const s = 1;\n`);
    const entry = write("Panel.tsx", `import { s } from "#state";\nexport const Panel = s;\n`);

    const externals = scanExternalDeps(entry, tmpDir, []);
    expect(externals).toContain("zustand");
    expect(externals).not.toContain("node-only-store");
  });

  it("leaves a specifier no imports map declares out of the dep list entirely", () => {
    write("package.json", JSON.stringify({ name: "p", imports: { "#app/*": "./app/*" } }));
    const entry = write("Widget.tsx", `import "#missing/thing";\nexport const W = 1;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toEqual([]);
  });

  it("resolves against the importer's own package, not the measured root", () => {
    write("package.json", JSON.stringify({ name: "root" }));
    write(
      "packages/ui/package.json",
      JSON.stringify({ name: "ui", imports: { "#internal/*": "./src/*" } }),
    );
    write("packages/ui/src/theme.ts", `import "tokens-pkg";\nexport const theme = 1;\n`);
    const entry = write(
      "packages/ui/src/Badge.tsx",
      `import { theme } from "#internal/theme";\nexport const Badge = theme;\n`,
    );

    expect(scanExternalDeps(entry, tmpDir, [])).toEqual(["tokens-pkg"]);
  });

  // M108 review: an imports entry may name a dependency instead of a local
  // file. That package is an ordinary external import; dropped from the
  // pre-bundle list, Vite discovers it on first page load and full-reloads.
  it("reports the package an imports entry points at, not the # specifier", () => {
    write("package.json", JSON.stringify({ name: "p", imports: { "#dep": "lodash-es" } }));
    const entry = write("List.tsx", `import { map } from "#dep";\nexport const List = map;\n`);

    const externals = scanExternalDeps(entry, tmpDir, []);
    expect(externals).toContain("lodash-es");
    expect(externals.filter((e) => e.startsWith("#"))).toEqual([]);
  });

  it("reports the package behind a * pattern that targets a dependency subpath", () => {
    write("package.json", JSON.stringify({ name: "p", imports: { "#icons/*": "lucide-react/*" } }));
    const entry = write("Icon.tsx", `import Eye from "#icons/eye";\nexport const Icon = Eye;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toEqual(["lucide-react"]);
  });
});
