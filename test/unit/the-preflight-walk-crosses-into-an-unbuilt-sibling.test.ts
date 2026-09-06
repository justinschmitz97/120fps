import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPreflight, preflightFailureMessage } from "../../src/project/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Workspace {
  root: string;
  app: string;
  entry: string;
  write: (rel: string, content: string) => string;
}

// A pnpm workspace: the sibling is reachable only through a node_modules symlink out of it.
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
  write(
    "packages/app/package.json",
    JSON.stringify({ name: "app", dependencies: { "@fix/sib": "workspace:*", react: "18.3.1" } }),
  );
  const entry = write(
    "packages/app/src/Card.tsx",
    'import { label } from "@fix/sib";\nexport function Card() { return null; }\nexport const shown = label;\n',
  );
  return { root, app: path.join(root, "packages", "app"), entry, write };
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

// Two edges deep, so the walk has to keep going after it crosses the package boundary.
function unbuiltSiblingWithYaml(prefix: string): Workspace {
  const ws = makeWorkspace(prefix);
  linkSibling(ws, "@fix/sib");
  ws.write(
    "packages/sib/package.json",
    JSON.stringify({ name: "@fix/sib", main: "./dist/index.js", types: "./dist/index.d.ts" }),
  );
  ws.write("packages/sib/src/index.ts", 'export { label } from "./deep.js";\n');
  ws.write(
    "packages/sib/src/deep.ts",
    'import table from "./data.yaml";\nexport const label = String(table);\n',
  );
  ws.write("packages/sib/src/data.yaml", "a: 1\n");
  return ws;
}

describe("an import of a workspace sibling whose declared entry is not on disk", () => {
  it("is walked as first-party source, so a data file behind it refuses the run", () => {
    const ws = unbuiltSiblingWithYaml("120fps-unbuilt-walk-");

    const { hard } = runPreflight({ projectRoot: ws.app, entries: [ws.entry] });

    const yamlHit = hard.find((hit) => hit.transformCode === "yaml");
    expect(yamlHit).toBeDefined();
    expect(yamlHit!.kind).toBe("unloadable-file-type");
    expect(yamlHit!.specifier).toBe("./data.yaml");
    // The chain starts at the measured component and names both sibling files it crossed.
    expect(yamlHit!.chain[0]).toBe("src/Card.tsx");
    expect(yamlHit!.chain.join(" ")).toContain("../sib/src/index.ts");
    expect(yamlHit!.chain.join(" ")).toContain("../sib/src/deep.ts");
  });

  it("refuses with a message naming the chain, the extension's loader and the way out", () => {
    const ws = unbuiltSiblingWithYaml("120fps-unbuilt-walk-msg-");

    const { hard } = runPreflight({ projectRoot: ws.app, entries: [ws.entry] });
    const message = preflightFailureMessage(hard);

    expect(message).toContain("data.yaml");
    expect(message).toContain("../sib/src/deep.ts");
    expect(message).toContain("YAML");
  });

  it("returns the identical decision for the dry-run entry list and the real-run one", () => {
    const ws = unbuiltSiblingWithYaml("120fps-unbuilt-walk-parity-");

    const dry = runPreflight({ projectRoot: ws.app, entries: [ws.entry] });
    const real = runPreflight({ projectRoot: ws.app, entries: [ws.entry] });

    expect(real.hard.map((hit) => hit.kind)).toEqual(dry.hard.map((hit) => hit.kind));
    expect(preflightFailureMessage(real.hard)).toBe(preflightFailureMessage(dry.hard));
  });
});

describe("an import of a workspace sibling whose declared entry is on disk", () => {
  it("stops at the package boundary, so its source is never gated", () => {
    const ws = unbuiltSiblingWithYaml("120fps-built-sibling-");
    ws.write("packages/sib/dist/index.js", 'export const label = "built";\n');

    const { hard } = runPreflight({ projectRoot: ws.app, entries: [ws.entry] });

    expect(hard.some((hit) => hit.transformCode === "yaml")).toBe(false);
  });
});

describe("an import of a third-party package", () => {
  it("stops at the package boundary even when the package ships a data file", () => {
    const ws = makeWorkspace("120fps-third-party-");
    const pkgDir = path.join(ws.app, "node_modules", "vendor-kit");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "vendor-kit", main: "./index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), 'import "./table.yaml";\nexport const x = 1;\n');
    fs.writeFileSync(path.join(pkgDir, "table.yaml"), "a: 1\n");
    fs.writeFileSync(
      path.join(ws.app, "src", "Card.tsx"),
      'import { x } from "vendor-kit";\nexport function Card() { return null; }\nexport const shown = x;\n',
    );

    const { hard, transforms } = runPreflight({ projectRoot: ws.app, entries: [ws.entry] });

    expect(hard.some((hit) => hit.transformCode === "yaml")).toBe(false);
    expect(transforms.some((hit) => hit.transformCode === "yaml")).toBe(false);
  });
});
