import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { runPreflight } from "../../src/project/index.js";
import { scanExternalDeps } from "../../src/harness/index.js";

// Two entries share one import chain; a second walk must reuse it, not re-walk per component.
const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "fixtures", "shared-import-graph");

// Minimal SFC parser stub: only the script block text (mirrors the loader-plugin test's stub).
const vueCompiler = {
  parse: (source: string) => {
    const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source);
    return { descriptor: { scriptSetup: match ? { content: match[1], lang: "ts" } : null } };
  },
};

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  if (!files["package.json"]) files["package.json"] = JSON.stringify({ name: "p" });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

// Explicit mtime avoids racing the filesystem's mtime granularity within one test.
function rewrite(file: string, content: string): void {
  fs.writeFileSync(file, content);
  const later = new Date(Date.now() + 4000);
  fs.utimesSync(file, later, later);
}

function reads(spy: { mock: { calls: unknown[][] } }, file: string): number {
  const target = path.resolve(file);
  return spy.mock.calls.filter((call) => path.resolve(String(call[0])) === target).length;
}

describe("the import graph walk", () => {
  it("reads every file of a shared chain once, however many components walk it", () => {
    const spy = vi.spyOn(ts.sys, "readFile");

    const first = runPreflight({ projectRoot: FIXTURE, entries: [path.join(FIXTURE, "a.tsx")] });
    const second = runPreflight({ projectRoot: FIXTURE, entries: [path.join(FIXTURE, "a.tsx")] });
    const sweptSibling = runPreflight({
      projectRoot: FIXTURE,
      entries: [path.join(FIXTURE, "b.tsx")],
    });

    expect(second).toEqual(first);
    expect(first.transforms.map((hit) => hit.specifier)).toContain("./data.yaml");
    expect(sweptSibling.transforms.map((hit) => hit.specifier)).toContain("./data.yaml");
    for (const file of ["a.tsx", "shared/one.ts", "shared/two.ts"]) {
      expect(reads(spy, path.join(FIXTURE, file))).toBe(1);
    }
    expect(reads(spy, path.join(FIXTURE, "b.tsx"))).toBe(1);
  });

  it("re-reads a file that was edited between two walks", () => {
    const root = makeProject("120fps-walk-edit-", {
      "Card.tsx": 'import { label } from "./child";\nexport const Card = () => label;\n',
      "child.ts": 'export const label = "x";\n',
    });
    const entries = [path.join(root, "Card.tsx")];

    const before = runPreflight({ projectRoot: root, entries });
    expect(before.transforms.map((hit) => hit.specifier)).toEqual([]);

    rewrite(
      path.join(root, "child.ts"),
      'import data from "./data.yaml";\nexport const label = data.title;\n',
    );
    fs.writeFileSync(path.join(root, "data.yaml"), "title: hello\n");

    const after = runPreflight({ projectRoot: root, entries });
    expect(after.transforms.map((hit) => hit.specifier)).toEqual(["./data.yaml"]);

    rewrite(path.join(root, "child.ts"), 'export const label = "x";\n');

    const reverted = runPreflight({ projectRoot: root, entries });
    expect(reverted.transforms.map((hit) => hit.specifier)).toEqual([]);
  });

  it("reads a file that did not exist at the first walk", () => {
    const root = makeProject("120fps-walk-appear-", {
      "Card.tsx": 'import { label } from "./late";\nexport const Card = () => label;\n',
    });
    const entries = [path.join(root, "Card.tsx")];

    const before = runPreflight({ projectRoot: root, entries });
    expect(before.transforms.map((hit) => hit.specifier)).toEqual([]);

    fs.writeFileSync(
      path.join(root, "late.ts"),
      'import data from "./data.yaml";\nexport const label = data.title;\n',
    );
    fs.writeFileSync(path.join(root, "data.yaml"), "title: hello\n");

    const after = runPreflight({ projectRoot: root, entries });
    expect(after.transforms.map((hit) => hit.specifier)).toEqual(["./data.yaml"]);
  });

  it("never serves a compiler-less parse of an SFC to a walk that has a compiler", () => {
    const files = {
      "Parent.vue":
        '<script setup lang="ts">\nimport messages from "./messages.yaml";\n</script>\n',
      "messages.yaml": "title: hello\n",
    };
    const bare = makeProject("120fps-walk-vue-bare-", { ...files });
    const bareEntries = [path.join(bare, "Parent.vue")];

    expect(
      runPreflight({ projectRoot: bare, entries: bareEntries }).transforms.map(
        (hit) => hit.specifier,
      ),
    ).toEqual([]);
    expect(
      runPreflight({ projectRoot: bare, entries: bareEntries, vueCompiler }).transforms.map(
        (hit) => hit.specifier,
      ),
    ).toContain("./messages.yaml");

    const compiled = makeProject("120fps-walk-vue-compiled-", { ...files });
    const compiledEntries = [path.join(compiled, "Parent.vue")];

    expect(
      runPreflight({ projectRoot: compiled, entries: compiledEntries, vueCompiler }).transforms.map(
        (hit) => hit.specifier,
      ),
    ).toContain("./messages.yaml");
    expect(
      runPreflight({ projectRoot: compiled, entries: compiledEntries }).transforms.map(
        (hit) => hit.specifier,
      ),
    ).toEqual([]);
  });
});

describe("the external dependency walk", () => {
  it("writes the same values into every output channel from its memo", () => {
    const root = makeProject("120fps-scan-memo-", {
      "Card.tsx":
        'import clsx from "clsx";\nimport { helper } from "./helper";\nexport const Card = () => clsx(helper);\n',
      "helper.ts": 'import shim from "missing-pkg";\nexport const helper = shim;\n',
    });
    const entry = path.join(root, "Card.tsx");
    const spy = vi.spyOn(fs, "readFileSync");

    const firstSpecifiers = new Set<string>();
    const firstWarnings: string[] = [];
    const firstUnresolved: Array<{ specifier: string; importer: string }> = [];
    const firstAliases: Array<{ find: RegExp; replacement: string }> = [];
    const first = scanExternalDeps(
      entry,
      root,
      [],
      firstSpecifiers,
      firstWarnings,
      root,
      firstAliases,
      firstUnresolved,
    );
    expect(reads(spy, entry)).toBe(1);

    const secondSpecifiers = new Set<string>();
    const secondWarnings: string[] = [];
    const secondUnresolved: Array<{ specifier: string; importer: string }> = [];
    const secondAliases: Array<{ find: RegExp; replacement: string }> = [];
    const second = scanExternalDeps(
      entry,
      root,
      [],
      secondSpecifiers,
      secondWarnings,
      root,
      secondAliases,
      secondUnresolved,
    );

    expect(second).toEqual(first);
    expect([...secondSpecifiers]).toEqual([...firstSpecifiers]);
    expect(secondWarnings).toEqual(firstWarnings);
    expect(secondUnresolved).toEqual(firstUnresolved);
    expect(secondAliases).toEqual(firstAliases);
    expect(reads(spy, entry)).toBe(1);
    expect(reads(spy, path.join(root, "helper.ts"))).toBe(1);
  });

  it("reports every specifier to a walk whose dedupe set started empty", () => {
    const root = makeProject("120fps-scan-prefilled-", {
      "Card.tsx": 'import clsx from "clsx";\nexport const Card = () => clsx("a");\n',
    });
    const entry = path.join(root, "Card.tsx");

    // Memo key covers only what the walk reads; a prefilled set must not shrink for a later walk.
    const prefilled = new Set<string>(["clsx"]);
    scanExternalDeps(entry, root, [], prefilled);

    const fresh = new Set<string>();
    scanExternalDeps(entry, root, [], fresh);

    expect([...fresh]).toEqual(["clsx"]);
  });

  it("walks again for a different alias set", () => {
    const root = makeProject("120fps-scan-alias-", {
      "Card.tsx": 'import clsx from "clsx";\nexport const Card = () => clsx("a");\n',
    });
    const entry = path.join(root, "Card.tsx");
    const spy = vi.spyOn(fs, "readFileSync");

    scanExternalDeps(entry, root, []);
    expect(reads(spy, entry)).toBe(1);

    scanExternalDeps(entry, root, [{ find: /^clsx$/, replacement: path.join(root, "Card.tsx") }]);
    expect(reads(spy, entry)).toBe(2);
  });

  it("re-reads an edited file before answering again", () => {
    const root = makeProject("120fps-scan-edit-", {
      "Card.tsx": 'import clsx from "clsx";\nexport const Card = () => clsx("a");\n',
    });
    const entry = path.join(root, "Card.tsx");

    expect(scanExternalDeps(entry, root, [])).toEqual(["clsx"]);

    rewrite(entry, 'import cva from "cva";\nexport const Card = () => cva("a");\n');

    expect(scanExternalDeps(entry, root, [])).toEqual(["cva"]);
  });
});
