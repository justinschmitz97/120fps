import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, explainProps } from "../../src/analyze.js";

// M91 (commerce-F3): a sync component's JSX can compose an async Server
// Component one hop away — the import-graph walk only asks whether
// entries[0] itself is async, so `app/page.tsx` passed --explain-props clean
// and then died with an obscure `__dirname is not defined` on the full run.
// Targeting the async child directly already produces a correct rejection;
// this suite proves both modes now reach it through the parent too.

describe("M91: RSC one-hop composition gate", () => {
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

  function commercePageFixture(prefix: string): { root: string; page: string; carousel: string } {
    const { root } = isolatedProject(prefix, {
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      "app/page.tsx": [
        "import { ThreeItemGrid } from '../components/grid/three-items';",
        "import { Carousel } from '../components/carousel';",
        "",
        "export default function HomePage() {",
        "  return (",
        "    <>",
        "      <ThreeItemGrid />",
        "      <Carousel />",
        "    </>",
        "  );",
        "}",
        "",
      ].join("\n"),
      "components/grid/three-items.tsx": [
        "export async function ThreeItemGrid() { return null; }",
        "",
      ].join("\n"),
      "components/carousel.tsx": [
        "export async function Carousel() { return null; }",
        "",
      ].join("\n"),
    });
    return {
      root,
      page: path.join(root, "app", "page.tsx"),
      carousel: path.join(root, "components", "carousel.tsx"),
    };
  }

  it("explainProps rejects the parent, naming the composed async child", async () => {
    const { page } = commercePageFixture("120fps-rsc-explain-");
    let thrown: Error | undefined;
    try {
      await explainProps(page);
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("Cannot measure this component in a browser");
    expect(thrown!.message).toMatch(/carousel\.tsx|three-items\.tsx/);
    expect(thrown!.message).toMatch(/React Server Component/);
  });

  it("the full run (analyze) rejects the same way, before any harness is built", async () => {
    const { page } = commercePageFixture("120fps-rsc-analyze-");
    let thrown: Error | undefined;
    try {
      await analyze(page);
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("Cannot measure this component in a browser");
    expect(thrown!.message).toMatch(/carousel\.tsx|three-items\.tsx/);
  });

  it("the chain names the parent before the child, not just the child alone", async () => {
    const { page } = commercePageFixture("120fps-rsc-chain-");
    let thrown: Error | undefined;
    try {
      await explainProps(page);
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toMatch(/page\.tsx[\s\S]*(carousel\.tsx|three-items\.tsx)/);
  });

  it("targeting the async child directly produces an equivalent rejection (control)", async () => {
    const { carousel } = commercePageFixture("120fps-rsc-control-");
    let thrown: Error | undefined;
    try {
      await explainProps(carousel);
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("Cannot measure this component in a browser");
    expect(thrown!.message).toMatch(/React Server Component/);
  });

  // M92 (Item 3): commerce's REAL app/page.tsx composes its children as
  // baseUrl-relative bare specifiers ("components/carousel", no leading
  // "./"), not the relative form the fixture above uses. Before the fix,
  // scanJsxComposedLocalImports excluded every bare specifier outright, so
  // the one-hop walk found zero composed children for exactly this shape --
  // explainProps passed clean and the full run died later with an obscure
  // `__dirname is not defined`.
  it("gates a baseUrl-relative bare specifier composed child, matching commerce's real shape", async () => {
    const { root } = isolatedProject("120fps-rsc-bareurl-", {
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "app/page.tsx": [
        "import { Carousel } from 'components/carousel';",
        "",
        "export default function HomePage() {",
        "  return <Carousel />;",
        "}",
        "",
      ].join("\n"),
      "components/carousel.tsx": [
        "export async function Carousel() { return null; }",
        "",
      ].join("\n"),
    });
    let thrown: Error | undefined;
    try {
      await explainProps(path.join(root, "app", "page.tsx"));
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain("Cannot measure this component in a browser");
    expect(thrown!.message).toMatch(/carousel\.tsx/);
    expect(thrown!.message).toMatch(/React Server Component/);
  });

  // A bare specifier that resolves into node_modules is a real dependency,
  // not a local composed child, and must stay excluded end to end -- the
  // classification the old dot-prefix filter used to provide, now done by
  // resolveRelativeJsxChild at resolution time instead.
  it("does not gate a bare specifier that resolves into node_modules", async () => {
    const { root } = isolatedProject("120fps-rsc-barepkg-", {
      "package.json": JSON.stringify({
        dependencies: { react: "18.3.1", "react-dom": "18.3.1", "some-ui-lib": "1.0.0" },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "app/page.tsx": [
        "import { Widget } from 'some-ui-lib';",
        "",
        "export default function HomePage() {",
        "  return <Widget />;",
        "}",
        "",
      ].join("\n"),
    });
    fs.mkdirSync(path.join(root, "node_modules", "some-ui-lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "some-ui-lib", "package.json"),
      JSON.stringify({ name: "some-ui-lib", version: "1.0.0", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(root, "node_modules", "some-ui-lib", "index.js"),
      "export async function Widget() { return null; }\n",
    );
    const explained = await explainProps(path.join(root, "app", "page.tsx"));
    expect(explained.componentName).toBe("HomePage");
  });

  it("does not reject when the composed child is a plain, non-async component", async () => {
    const { root } = isolatedProject("120fps-rsc-negative-", {
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      "app/page.tsx": [
        "import { Footer } from '../components/footer';",
        "",
        "export default function HomePage() {",
        "  return <Footer />;",
        "}",
        "",
      ].join("\n"),
      "components/footer.tsx": [
        "export function Footer() { return null; }",
        "",
      ].join("\n"),
    });
    const explained = await explainProps(path.join(root, "app", "page.tsx"));
    expect(explained.componentName).toBe("HomePage");
  });
});
