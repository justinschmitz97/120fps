import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractPropsDetailed, resetExtractionCache } from "../../src/props/index.js";
import { UNRESOLVED_ANNOTATION_MODULE_WARNING } from "../../src/props/index.js";

const cleanupDirs: string[] = [];
const REPO_MODULES = path.resolve("node_modules");

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetExtractionCache();
});

interface Workspace {
  root: string;
  app: string;
  write: (rel: string, content: string) => string;
}

// react's own declarations come from this repository's install; the workspace stays synthetic.
function makeWorkspace(prefix: string): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(root);
  const write = (rel: string, content: string): string => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("package.json", JSON.stringify({ name: "root", private: true }));
  fs.symlinkSync(
    REPO_MODULES,
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  write(
    "packages/app/package.json",
    JSON.stringify({ name: "app", dependencies: { "@fix/ui": "workspace:*", react: "18.3.1" } }),
  );
  write(
    "packages/app/tsconfig.json",
    JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }),
  );
  return { root, app: path.join(root, "packages", "app"), write };
}

function linkSibling(ws: Workspace, scopedName: string): string {
  const [scope, name] = scopedName.split("/");
  const real = path.join(ws.root, "packages", name);
  fs.mkdirSync(real, { recursive: true });
  const linkParent = path.join(ws.app, "node_modules", scope);
  fs.mkdirSync(linkParent, { recursive: true });
  fs.symlinkSync(
    real,
    path.join(linkParent, name),
    process.platform === "win32" ? "junction" : "dir",
  );
  return real;
}

const CONSUMER =
  'import type { ComponentProps } from "react";\n' +
  'import { EmptyStateBlock } from "@fix/ui";\n' +
  "export function EmptyState(props: Omit<ComponentProps<typeof EmptyStateBlock>, \"children\">) {\n" +
  "  return null;\n" +
  "}\n";

const SIBLING_SOURCE =
  "export function EmptyStateBlock(props: {\n" +
  "  icon: string;\n" +
  "  title?: string;\n" +
  "  children?: unknown;\n" +
  "}) {\n" +
  "  return null;\n" +
  "}\n";

function unbuiltSiblingWorkspace(prefix: string): { entry: string; real: string } {
  const ws = makeWorkspace(prefix);
  const real = linkSibling(ws, "@fix/ui");
  ws.write(
    "packages/ui/package.json",
    JSON.stringify({ name: "@fix/ui", main: "./dist/index.js", types: "./dist/index.d.ts" }),
  );
  ws.write("packages/ui/src/index.tsx", SIBLING_SOURCE);
  const entry = ws.write("packages/app/src/EmptyState.tsx", CONSUMER);
  return { entry, real };
}

describe("a props type that crosses into a workspace sibling with no built entry", () => {
  it("extracts the required props the sibling's source declares", async () => {
    const { entry } = unbuiltSiblingWorkspace("120fps-sibling-types-");

    const { schemas } = await extractPropsDetailed(entry);

    const icon = schemas.find((schema) => schema.name === "icon");
    expect(icon).toBeDefined();
    expect(icon!.required).toBe(true);
    expect(schemas.map((schema) => schema.name)).toContain("title");
    expect(schemas.map((schema) => schema.name)).not.toContain("children");
  });

  it("extracts the same props when the sibling is built", async () => {
    const { entry, real } = unbuiltSiblingWorkspace("120fps-sibling-types-built-");
    fs.mkdirSync(path.join(real, "dist"), { recursive: true });
    fs.writeFileSync(path.join(real, "dist", "index.js"), "export function EmptyStateBlock() {}\n");
    fs.writeFileSync(
      path.join(real, "dist", "index.d.ts"),
      "export declare function EmptyStateBlock(props: {\n" +
        "  icon: string;\n" +
        "  title?: string;\n" +
        "  children?: unknown;\n" +
        "}): null;\n",
    );

    const { schemas } = await extractPropsDetailed(entry);

    expect(schemas.find((schema) => schema.name === "icon")?.required).toBe(true);
    expect(schemas.map((schema) => schema.name)).toContain("title");
  });
});

describe("a props annotation whose module resolves nowhere", () => {
  it("warns, naming the module and the annotation", async () => {
    const ws = makeWorkspace("120fps-annotation-unresolved-");
    const entry = ws.write(
      "packages/app/src/Card.tsx",
      'import type { ComponentProps } from "react";\n' +
        'import { Missing } from "nowhere-at-all";\n' +
        'export function Card(props: Omit<ComponentProps<typeof Missing>, "children">) {\n' +
        "  return null;\n" +
        "}\n",
    );

    const collected: string[] = [];
    await extractPropsDetailed(entry, { onWarning: (message) => collected.push(message) });

    const annotation = 'Omit<ComponentProps<typeof Missing>, "children">';
    // A collected entry carries no "Warning: " prefix; the reader that prints it adds one.
    expect(collected).toContain(
      UNRESOLVED_ANNOTATION_MODULE_WARNING(entry, "Card", annotation, ["nowhere-at-all"])
        .replace(/^Warning: /, ""),
    );
  });

  it("warns even when the annotation still yields props", async () => {
    const ws = makeWorkspace("120fps-annotation-partial-");
    const entry = ws.write(
      "packages/app/src/Card.tsx",
      'import type { ComponentProps } from "react";\n' +
        'import { Missing } from "nowhere-at-all";\n' +
        "export function Card(props: { label?: string; block: ComponentProps<typeof Missing> }) {\n" +
        "  return null;\n" +
        "}\n",
    );

    const collected: string[] = [];
    const { schemas } = await extractPropsDetailed(entry, {
      onWarning: (message) => collected.push(message),
    });

    expect(schemas.map((schema) => schema.name)).toContain("label");
    expect(collected.some((message) => message.includes("nowhere-at-all"))).toBe(true);
  });

  it("says nothing for a component that declares no props at all", async () => {
    const ws = makeWorkspace("120fps-annotation-none-");
    const entry = ws.write(
      "packages/app/src/Card.tsx",
      "export function Card() {\n  return null;\n}\n",
    );

    const collected: string[] = [];
    await extractPropsDetailed(entry, { onWarning: (message) => collected.push(message) });

    expect(collected.some((message) => message.includes("resolves to no module"))).toBe(false);
  });

  it("says nothing when every module in the annotation resolves", async () => {
    const { entry } = unbuiltSiblingWorkspace("120fps-annotation-resolved-");

    const collected: string[] = [];
    await extractPropsDetailed(entry, { onWarning: (message) => collected.push(message) });

    expect(collected.some((message) => message.includes("resolves to no module"))).toBe(false);
  });
});
