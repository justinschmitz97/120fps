import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanExternalDeps, SHIM_MODULES, buildShimAliases } from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m62-h-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string) {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function stub(name: string) {
  return write(name, "export default function Stub() { return null; }\n");
}

function shimAlias(module: string, replacement: string) {
  const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { find: new RegExp(`^${escaped}$`), replacement, isShim: true };
}

// H1: shim module imported only transitively (two hops away)
describe("H1: transitive shim import", () => {
  it("records the specifier when a local helper (not the entry) imports it", () => {
    const shimTarget = stub("shims/next-image.js");
    const helper = write(
      "Helper.tsx",
      `import Image from "next/image";\nexport function Helper() { return null; }\n`,
    );
    const entry = write("Entry.tsx", `import { Helper } from "./Helper";\nexport function Entry() { return null; }\n`);
    const alias = [shimAlias("next/image", shimTarget)];

    const specs = new Set<string>();
    scanExternalDeps(entry, tmpDir, alias, specs);

    expect(specs.has("next/image")).toBe(true);
  });
});

// H2: imported via re-export
describe("H2: re-exported shim import", () => {
  it("records the specifier for `export { default as Img } from \"next/image\"`", () => {
    const shimTarget = stub("shims/next-image.js");
    const entry = write(
      "Entry.tsx",
      `export { default as Img } from "next/image";\nexport function Entry() { return null; }\n`,
    );
    const alias = [shimAlias("next/image", shimTarget)];

    const specs = new Set<string>();
    scanExternalDeps(entry, tmpDir, alias, specs);

    expect(specs.has("next/image")).toBe(true);
  });

  it("records the specifier for `export * from \"next/navigation\"`", () => {
    const shimTarget = stub("shims/next-navigation.js");
    const entry = write(
      "Entry.tsx",
      `export * from "next/navigation";\nexport function Entry() { return null; }\n`,
    );
    const alias = [shimAlias("next/navigation", shimTarget)];

    const specs = new Set<string>();
    scanExternalDeps(entry, tmpDir, alias, specs);

    expect(specs.has("next/navigation")).toBe(true);
  });
});

// H3: multiple shim modules imported at once
describe("H3: multiple shim modules at once", () => {
  it("records every shim module the graph imports, in SHIM_MODULES order", () => {
    const imageTarget = stub("shims/next-image.js");
    const linkTarget = stub("shims/next-link.js");
    const navTarget = stub("shims/next-navigation.js");
    const entry = write(
      "Entry.tsx",
      [
        `import Image from "next/image";`,
        `import Link from "next/link";`,
        `import { useRouter } from "next/navigation";`,
        `export function Entry() { return null; }`,
        "",
      ].join("\n"),
    );
    const alias = [
      shimAlias("next/image", imageTarget),
      shimAlias("next/link", linkTarget),
      shimAlias("next/navigation", navTarget),
    ];

    const specs = new Set<string>();
    scanExternalDeps(entry, tmpDir, alias, specs);

    const shimmed = SHIM_MODULES.filter((s) => specs.has(s.module)).map((s) => s.module);
    expect(shimmed).toEqual(["next/image", "next/link", "next/navigation"]);
  });
});

// H4: user project has its own local module shadowing a shim name
describe("H4: non-shim alias shadows a shim-shaped specifier", () => {
  it("does not record the specifier when a non-shim alias (e.g. tsconfig paths) wins the match", () => {
    // No isShim flag: mirrors a user's own tsconfig `next/image` -> local path.
    const userOwnModule = stub("MyImage.tsx");
    const entry = write("Entry.tsx", `import Image from "next/image";\nexport function Entry() { return null; }\n`);
    const alias = [{ find: /^next\/image$/, replacement: userOwnModule }];

    const specs = new Set<string>();
    scanExternalDeps(entry, tmpDir, alias, specs);

    expect(specs.has("next/image")).toBe(false);
  });

  it("first-match-wins: a user alias listed before the shim alias shadows it", () => {
    const userOwnModule = stub("MyImage.tsx");
    const shimTarget = stub("shims/next-image.js");
    const entry = write("Entry.tsx", `import Image from "next/image";\nexport function Entry() { return null; }\n`);
    // tsconfig aliases are placed before shim aliases in production (buildAndServe).
    const alias = [
      { find: /^next\/image$/, replacement: userOwnModule },
      shimAlias("next/image", shimTarget),
    ];

    const specs = new Set<string>();
    scanExternalDeps(entry, tmpDir, alias, specs);

    expect(specs.has("next/image")).toBe(false);
  });
});

// H5: --no-shims path (no shim aliases registered at all)
describe("H5: shims disabled entirely", () => {
  it("buildShimAliases(false) yields no aliases, so a next/image import is a genuine external specifier", () => {
    const alias = buildShimAliases(false);
    expect(alias).toEqual([]);

    const entry = write("Entry.tsx", `import Image from "next/image";\nexport function Entry() { return null; }\n`);
    const specs = new Set<string>();
    const pkgs = scanExternalDeps(entry, tmpDir, alias, specs);

    // Still recorded as a raw specifier (existing behavior): it is the
    // harness's `if (hasNextJs)` gate, not scanExternalDeps, that suppresses
    // activeShims when shims are off.
    expect(specs.has("next/image")).toBe(true);
    // "next" itself is BLOCKED from optimizeDeps regardless.
    expect(pkgs).not.toContain("next");
  });
});

// H6: non-TSX (Vue-style) file content is scanned the same way
describe("H6: Vue-flavored source file", () => {
  it("still records a shim-redirected specifier when the extension is .vue", () => {
    const shimTarget = stub("shims/next-image.js");
    const entry = write(
      "Entry.vue",
      `<script setup lang="ts">\nimport Image from "next/image";\n</script>\n<template><div /></template>\n`,
    );
    const alias = [shimAlias("next/image", shimTarget)];

    const specs = new Set<string>();
    scanExternalDeps(entry, tmpDir, alias, specs);

    expect(specs.has("next/image")).toBe(true);
  });
});

// H7: hyphenated shim module name (regex-special char) still resolves and records
describe("H7: hyphenated module name via buildShimAliases", () => {
  it("next-video/player is recorded through its real alias", () => {
    const aliases = buildShimAliases(true);
    const entry = write(
      "Entry.tsx",
      `import Player from "next-video/player";\nexport function Entry() { return null; }\n`,
    );

    const specs = new Set<string>();
    scanExternalDeps(entry, tmpDir, aliases, specs);

    expect(specs.has("next-video/player")).toBe(true);
  });
});

// H8: a relative path that textually resembles a shim module must not pollute specifiersOut
describe("H8: relative path shaped like a shim module name", () => {
  it("./next/image (relative import) is never treated as a bare specifier", () => {
    stub("next/image.tsx");
    const entry = write(
      "Entry.tsx",
      `import Image from "./next/image";\nexport function Entry() { return null; }\n`,
    );
    const alias = [shimAlias("next/image", stub("shims/next-image.js"))];

    const specs = new Set<string>();
    const pkgs = scanExternalDeps(entry, tmpDir, alias, specs);

    expect(specs.has("next/image")).toBe(false);
    expect(specs.has("./next/image")).toBe(false);
    expect(pkgs).toEqual([]);
  });
});

// H9: wrap-path style dual scan shares the specifiersOut set across two entry points
describe("H9: two independent scans sharing one specifiersOut set", () => {
  it("unions shim usage from a component scan and a separate wrapper scan", () => {
    const imageTarget = stub("shims/next-image.js");
    const linkTarget = stub("shims/next-link.js");
    const component = write(
      "Component.tsx",
      `import Image from "next/image";\nexport function Component() { return null; }\n`,
    );
    const wrapper = write(
      "Wrapper.tsx",
      `import Link from "next/link";\nexport function Wrapper() { return null; }\n`,
    );
    const alias = [shimAlias("next/image", imageTarget), shimAlias("next/link", linkTarget)];

    const specs = new Set<string>();
    scanExternalDeps(component, tmpDir, alias, specs);
    scanExternalDeps(wrapper, tmpDir, alias, specs);

    const shimmed = SHIM_MODULES.filter((s) => specs.has(s.module)).map((s) => s.module);
    expect(shimmed).toEqual(["next/image", "next/link"]);
  });
});
