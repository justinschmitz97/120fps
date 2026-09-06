import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPreflight, preflightFailureMessage } from "../../src/project/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function project(
  prefix: string,
  files: Record<string, string>,
): { root: string; entry: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  return { root, entry: path.join(root, "src", "Card.tsx") };
}

const MANIFEST = JSON.stringify({ name: "app", dependencies: { react: "18.3.1" } });
const TSCONFIG = JSON.stringify({
  compilerOptions: { baseUrl: ".", paths: { "~/*": ["./src/*"] } },
});
const ENTRY = 'import { helper } from "./helper";\nexport function Card() { return helper; }\n';

describe("an aliased import whose target is not on disk", () => {
  it("is a hard preflight hit naming the importer, the specifier and the target", () => {
    const { root, entry } = project("120fps-stale-alias-graph-", {
      "package.json": MANIFEST,
      "tsconfig.json": TSCONFIG,
      "src/Card.tsx": ENTRY,
      "src/helper.ts": 'import { gone } from "~/hooks/useGone";\nexport const helper = gone;\n',
    });

    const { hard } = runPreflight({ projectRoot: root, entries: [entry] });

    const hit = hard.find((candidate) => candidate.kind === "unresolved-alias");
    expect(hit).toBeDefined();
    expect(hit!.specifier).toBe("~/hooks/useGone");
    expect(hit!.chain[hit!.chain.length - 1]).toBe("src/helper.ts");
    const message = preflightFailureMessage(hard);
    expect(message).toContain("src/helper.ts");
    expect(message).toContain("~/hooks/useGone");
    expect(message).toContain("src/hooks/useGone");
  });

  it("produces the same refusal text on two identical walks", () => {
    const { root, entry } = project("120fps-stale-alias-parity-", {
      "package.json": MANIFEST,
      "tsconfig.json": TSCONFIG,
      "src/Card.tsx": ENTRY,
      "src/helper.ts": 'import { gone } from "~/hooks/useGone";\nexport const helper = gone;\n',
    });

    const dry = runPreflight({ projectRoot: root, entries: [entry] });
    const real = runPreflight({ projectRoot: root, entries: [entry] });

    expect(preflightFailureMessage(real.hard)).toBe(preflightFailureMessage(dry.hard));
  });

  it("says nothing when no file in the graph imports it", () => {
    const { root, entry } = project("120fps-stale-alias-outside-", {
      "package.json": MANIFEST,
      "tsconfig.json": TSCONFIG,
      "src/Card.tsx": ENTRY,
      "src/helper.ts": "export const helper = 1;\n",
      "src/unreached.ts": 'import { gone } from "~/hooks/useGone";\nexport const other = gone;\n',
    });

    const { hard } = runPreflight({ projectRoot: root, entries: [entry] });

    expect(hard.map((hit) => hit.kind)).not.toContain("unresolved-alias");
  });

  it("says nothing for a type-only import, which no browser ever loads", () => {
    const { root, entry } = project("120fps-stale-alias-type-only-", {
      "package.json": MANIFEST,
      "tsconfig.json": TSCONFIG,
      "src/Card.tsx": ENTRY,
      "src/helper.ts":
        'import type { Gone } from "~/hooks/useGone";\nexport const helper: Gone | number = 1;\n',
    });

    const { hard } = runPreflight({ projectRoot: root, entries: [entry] });

    expect(hard.map((hit) => hit.kind)).not.toContain("unresolved-alias");
  });

  it("says nothing when the alias target is on disk", () => {
    const { root, entry } = project("120fps-stale-alias-present-", {
      "package.json": MANIFEST,
      "tsconfig.json": TSCONFIG,
      "src/Card.tsx": ENTRY,
      "src/helper.ts": 'import { gone } from "~/hooks/useGone";\nexport const helper = gone;\n',
      "src/hooks/useGone.ts": "export const gone = 1;\n",
    });

    const { hard } = runPreflight({ projectRoot: root, entries: [entry] });

    expect(hard.map((hit) => hit.kind)).not.toContain("unresolved-alias");
  });
});

describe("a path alias with no prefix of its own", () => {
  it("refuses nothing, because it matches every bare specifier", () => {
    const { root, entry } = project("120fps-stale-alias-catch-all-", {
      "package.json": MANIFEST,
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "*": ["./*"] } } }),
      "src/Card.tsx": ENTRY,
      "src/helper.ts": 'import clsx from "clsx";\nexport const helper = clsx;\n',
    });

    const { hard } = runPreflight({ projectRoot: root, entries: [entry] });

    expect(hard.map((hit) => hit.kind)).not.toContain("unresolved-alias");
  });
});
