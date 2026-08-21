import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  extractProps,
  extractPropsDetailed,
  isUntypedJsComponentWarning,
} from "../../src/prop-gen.js";

const FIXTURES = path.resolve(__dirname, "../../fixtures/js-with-dts");

const cleanupDirs: string[] = [];
function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-jsdts-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// material-ui-F1: Badge.js reported exactly two props, `ref` and `key`, while
// Badge.d.ts next to it declares sixteen. Both are React's own ambient
// attributes, so every measured combo was an empty-props mount.

describe("a .js component whose types live in a sibling .d.ts", () => {
  it("takes its props from the declaration", async () => {
    const names = (await extractProps(path.join(FIXTURES, "Badge.js"))).map((s) => s.name);

    expect(names).toEqual(
      expect.arrayContaining(["badgeContent", "color", "invisible", "max", "variant", "overlap"]),
    );
  });

  it("never presents React's ambient attributes as the contract", async () => {
    const names = (await extractProps(path.join(FIXTURES, "Badge.js"))).map((s) => s.name);

    expect(names).not.toContain("ref");
    expect(names).not.toContain("key");
  });

  it("types a declared literal union as a union with its values", async () => {
    const color = (await extractProps(path.join(FIXTURES, "Badge.js"))).find(
      (s) => s.name === "color",
    );

    expect(color?.kind).toBe("union");
    expect(color?.values).toEqual(
      expect.arrayContaining(["default", "primary", "secondary", "error"]),
    );
  });

  it("reports no untyped-component warning when a declaration answered", async () => {
    const { warnings } = await extractPropsDetailed(path.join(FIXTURES, "Badge.js"), {
      onWarning: () => {},
    });

    expect(warnings.filter(isUntypedJsComponentWarning)).toEqual([]);
  });

  it("reads a .d.ts named by the package's own types entry, not only a sibling", async () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "typed-pkg", main: "widget.js", types: "widget-types.d.ts" }),
      "widget.js": [
        "export default function Widget(props) {",
        "  return props.caption;",
        "}",
      ].join("\n"),
      "widget-types.d.ts": [
        "export interface WidgetProps { caption?: string; rows?: number }",
        "declare const Widget: (props: WidgetProps) => null;",
        "export default Widget;",
      ].join("\n"),
    });

    const names = (await extractProps(path.join(dir, "widget.js"))).map((s) => s.name);

    expect(names).toEqual(expect.arrayContaining(["caption", "rows"]));
  });
});

describe("a .js component with no declaration to fall back on", () => {
  it("still extracts the props its destructuring defaults imply", async () => {
    const names = (await extractProps(path.join(FIXTURES, "PlainDefaults.js"))).map((s) => s.name);

    expect(names).toEqual(expect.arrayContaining(["label", "count", "muted"]));
  });

  it("extracts nothing from an untyped parameter and names why", async () => {
    const { schemas, warnings } = await extractPropsDetailed(path.join(FIXTURES, "Bare.js"), {
      onWarning: () => {},
    });

    expect(schemas).toEqual([]);
    const named = warnings.filter(isUntypedJsComponentWarning);
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("Bare");
    expect(named[0]).toContain("Bare.js");
  });

  it("reports an unannotated forwardRef as unresolved instead of as ref and key", async () => {
    const { schemas, warnings } = await extractPropsDetailed(
      path.join(FIXTURES, "WrappedNoTypes.js"),
      { onWarning: () => {} },
    );

    expect(schemas.map((s) => s.name)).toEqual([]);
    expect(warnings.filter(isUntypedJsComponentWarning)).toHaveLength(1);
  });

  it("does not warn for a JS component whose props did resolve", async () => {
    const { warnings } = await extractPropsDetailed(path.join(FIXTURES, "PlainDefaults.js"), {
      onWarning: () => {},
    });

    expect(warnings.filter(isUntypedJsComponentWarning)).toEqual([]);
  });
});

describe("declaration lookup stays out of TypeScript entries", () => {
  it("keeps a .tsx component bound to its own source when a stale .d.ts sits beside it", async () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "ts-app" }),
      "Panel.tsx": [
        "export interface PanelProps { title?: string; open?: boolean }",
        "export function Panel({ title, open }: PanelProps) {",
        "  return <div>{open ? title : null}</div>;",
        "}",
        "export default Panel;",
      ].join("\n"),
      "Panel.d.ts": [
        "export interface StalePanelProps { stale?: string }",
        "declare const Panel: (props: StalePanelProps) => null;",
        "export default Panel;",
      ].join("\n"),
    });

    const names = (await extractProps(path.join(dir, "Panel.tsx"))).map((s) => s.name);

    expect(names).toEqual(expect.arrayContaining(["title", "open"]));
    expect(names).not.toContain("stale");
  });

  it("keeps a component that genuinely declares a prop named ref", async () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "own-ref" }),
      "Field.tsx": [
        "export interface FieldProps { ref?: string; name?: string }",
        "export function Field({ ref, name }: FieldProps) { return <i>{ref}{name}</i>; }",
      ].join("\n"),
    });

    const names = (await extractProps(path.join(dir, "Field.tsx"))).map((s) => s.name);

    expect(names).toEqual(expect.arrayContaining(["ref", "name"]));
  });
});
