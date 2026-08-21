import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/analyze.js";
import { scanJsxComposedLocalImports } from "../../src/composition.js";

// M91 harden: adversarial hypotheses against the RSC one-hop composition
// gate and the JSX-composed-import scanner.

describe("M91 harden: scanJsxComposedLocalImports", () => {
  it("#1 ignores a type-only import even when its name matches a JSX tag", () => {
    const src = [
      "import type { Foo } from './foo';",
      "function Page() { return <Foo />; }",
    ].join("\n");
    expect(scanJsxComposedLocalImports(src, "page.tsx")).toEqual([]);
  });

  // M92 (Item 3, commerce's app/page.tsx): a bare specifier is now collected
  // by the scanner too -- commerce's real composed children are
  // baseUrl-relative bare specifiers ("components/carousel", no leading
  // "./"), which the scanner has no tsconfig context to classify on its own.
  // Whether a bare specifier is a real npm package (excluded) or a local
  // project file (kept) is decided downstream, at resolution time
  // (resolveRelativeJsxChild in analyze.ts), not here.
  it("#2 still collects a bare (non-relative) import -- classification moved downstream", () => {
    const src = [
      "import { Foo } from 'some-package';",
      "function Page() { return <Foo />; }",
    ].join("\n");
    expect(scanJsxComposedLocalImports(src, "page.tsx")).toEqual([
      { name: "Foo", specifier: "some-package" },
    ]);
  });

  it("#3 ignores an import never used as a JSX tag", () => {
    const src = [
      "import { Foo } from './foo';",
      "function Page() { return Foo(); }",
    ].join("\n");
    expect(scanJsxComposedLocalImports(src, "page.tsx")).toEqual([]);
  });

  it("#4 dedupes a component used as a JSX tag more than once", () => {
    const src = [
      "import { Foo } from './foo';",
      "function Page() { return <><Foo /><Foo /></>; }",
    ].join("\n");
    expect(scanJsxComposedLocalImports(src, "page.tsx")).toHaveLength(1);
  });

  it("#5 ignores a member-expression JSX tag (namespace import)", () => {
    const src = [
      "import * as Foo from './foo';",
      "function Page() { return <Foo.Bar />; }",
    ].join("\n");
    expect(scanJsxComposedLocalImports(src, "page.tsx")).toEqual([]);
  });

  it("#6 picks up a default-imported component", () => {
    const src = [
      "import Foo from './foo';",
      "function Page() { return <Foo />; }",
    ].join("\n");
    expect(scanJsxComposedLocalImports(src, "page.tsx")).toEqual([{ name: "Foo", specifier: "./foo" }]);
  });

  it("#7 does not crash on malformed/incomplete source", () => {
    const src = "import { Foo } from './foo'; function Page() { return <Foo";
    expect(() => scanJsxComposedLocalImports(src, "page.tsx")).not.toThrow();
  });
});

describe("M91 harden: composedChildPreflightHits via explainProps", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function isolatedProject(prefix: string, files: Record<string, string>): { root: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const pkgDir = path.join(root, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "react-dom", version: "18.3.1", main: "index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};\n");
    return { root };
  }

  // #8: a broken/typo'd relative import composed as JSX must not crash the
  // dry run — it simply resolves to nothing and is skipped.
  it("#8 a JSX-composed import that resolves to no file on disk does not crash", async () => {
    const { root } = isolatedProject("120fps-rsc-harden-missing-", {
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      "app/page.tsx": [
        "import { Ghost } from '../components/does-not-exist';",
        "export default function HomePage() { return <Ghost />; }",
      ].join("\n"),
    });
    const explained = await explainProps(path.join(root, "app", "page.tsx"));
    expect(explained.componentName).toBe("HomePage");
  });

  // #9: a component that JSX-composes itself (self-referential) does not
  // hang or infinitely recurse.
  it("#9 a self-composing component does not hang", async () => {
    const { root } = isolatedProject("120fps-rsc-harden-self-", {
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      "Tree.tsx": [
        "import { Tree } from './Tree';",
        "export function Tree() { return <Tree />; }",
      ].join("\n"),
    });
    const explained = await explainProps(path.join(root, "Tree.tsx"));
    expect(explained.componentName).toBe("Tree");
  });

  // #10: an async child reached only through a *type-only* JSX-adjacent
  // import must not be gated (matches the scanner's own type-only exclusion).
  it("#10 a type-only import of an async component's type is not gated", async () => {
    const { root } = isolatedProject("120fps-rsc-harden-typeonly-", {
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      "app/page.tsx": [
        "import type { CarouselProps } from '../components/carousel';",
        "export default function HomePage(props: CarouselProps) { return null; }",
      ].join("\n"),
      "components/carousel.tsx": [
        "export interface CarouselProps { count: number }",
        "export async function Carousel() { return null; }",
      ].join("\n"),
    });
    const explained = await explainProps(path.join(root, "app", "page.tsx"));
    expect(explained.componentName).toBe("HomePage");
  });
});
