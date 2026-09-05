import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import {
  runPreflight,
  preflightFailureMessage,
  PREFLIGHT_BYPASSED_WARNING,
} from "../../src/project/index.js";

const MACRO_FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "macro-import-project",
);
const VIRTUAL_FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "virtual-namespace-project",
);

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function isolatedProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-macro-refusal-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const reactDom = path.join(root, "node_modules", "react-dom");
  fs.mkdirSync(reactDom, { recursive: true });
  fs.writeFileSync(
    path.join(reactDom, "package.json"),
    JSON.stringify({ name: "react-dom", version: "19.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(reactDom, "index.js"), "module.exports = {};\n");
  return root;
}

describe("an import of a Babel macro", () => {
  it("is a hard preflight hit, so the refusal happens before a browser starts", () => {
    const entry = path.join(MACRO_FIXTURE, "src", "Dialog.tsx");

    const preflight = runPreflight({ projectRoot: MACRO_FIXTURE, entries: [entry] });

    const hit = preflight.hard.find((h) => h.kind === "unloadable-macro");
    expect(hit?.specifier).toBe("@lingui/react/macro");
    expect(hit?.transformCode).toBe("babel-macro");
    expect(hit?.transformOwner).toBe("vite-plugin-babel-macros");
  });

  it("stays in the transform list, so --no-preflight still names the compiler", () => {
    const entry = path.join(MACRO_FIXTURE, "src", "Dialog.tsx");

    const preflight = runPreflight({ projectRoot: MACRO_FIXTURE, entries: [entry] });

    expect(preflight.transforms.map((h) => h.specifier)).toContain("@lingui/react/macro");
  });

  it("names the importer, the macro, the declared compiler and the way out", () => {
    const entry = path.join(MACRO_FIXTURE, "src", "Dialog.tsx");
    const preflight = runPreflight({ projectRoot: MACRO_FIXTURE, entries: [entry] });

    const message = preflightFailureMessage(preflight.hard);

    expect(message).toContain("src/Dialog.tsx imports @lingui/react/macro");
    expect(message).toContain("This project compiles that with vite-plugin-babel-macros.");
    expect(message).toContain("write the macro call out by hand");
    expect(message).toContain("--no-preflight");
    expect(message).not.toContain("run that package's own build first");
  });

  it("says no compiler is declared instead of naming one the project does not have", () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({ name: "p", dependencies: { react: "19.0.0" } }),
      "Widget.tsx": 'import { css } from "styles/macro";\nexport const Widget = () => css;\n',
    });

    const preflight = runPreflight({ projectRoot: root, entries: [path.join(root, "Widget.tsx")] });

    const message = preflightFailureMessage(preflight.hard);
    expect(preflight.hard[0]?.transformOwnerDeclared).toBeUndefined();
    expect(message).toContain("Nothing in this project declares a macro compiler");
    expect(message).not.toContain("This project compiles that with");
  });

  it("names the file that imports the macro, not the measured component", () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({
        name: "p",
        dependencies: { react: "19.0.0" },
        devDependencies: { "babel-plugin-macros": "3.1.0" },
      }),
      "src/Parent.tsx": 'import { Child } from "./Child";\nexport const Parent = () => Child;\n',
      "src/Child.tsx": 'import { t } from "@lingui/core/macro";\nexport const Child = t;\n',
    });

    const preflight = runPreflight({
      projectRoot: root,
      entries: [path.join(root, "src", "Parent.tsx")],
    });

    const message = preflightFailureMessage(preflight.hard);
    expect(message).toContain("src/Child.tsx imports @lingui/core/macro");
    expect(message).toContain("src/Parent.tsx → src/Child.tsx → @lingui/core/macro");
  });
});

describe("an import that only looks like a macro", () => {
  it("leaves the project's own ./macro module an ordinary graph edge", () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({ name: "p", dependencies: { react: "19.0.0" } }),
      "macro.ts": "export const macro = 1;\n",
      "Widget.tsx": 'import { macro } from "./macro";\nexport const Widget = () => macro;\n',
    });

    const preflight = runPreflight({ projectRoot: root, entries: [path.join(root, "Widget.tsx")] });

    expect(preflight.hard).toEqual([]);
  });

  it("leaves a virtual-namespace import a warning, as an unrun plugin is not a macro", () => {
    const entry = path.join(VIRTUAL_FIXTURE, "src", "Icon.tsx");

    const preflight = runPreflight({ projectRoot: VIRTUAL_FIXTURE, entries: [entry] });

    expect(preflight.hard).toEqual([]);
    expect(preflight.transforms.map((h) => h.transformCode)).toContain("virtual-module");
  });
});

describe("--no-preflight on a macro import", () => {
  it("reports the finding as a macro and lets the rest of the pipeline run", async () => {
    const entry = path.join(MACRO_FIXTURE, "src", "Dialog.tsx");
    const preflight = runPreflight({ projectRoot: MACRO_FIXTURE, entries: [entry] });

    const warning = PREFLIGHT_BYPASSED_WARNING(preflight.hard);

    expect(warning).toContain("1 babel-macro finding");
    await expect(explainProps(entry, { noPreflight: true })).resolves.toBeDefined();
  });
});

describe("the dry run's prediction of that refusal", () => {
  it("refuses with the same string the real run's preflight gate throws", async () => {
    const entry = path.join(MACRO_FIXTURE, "src", "Dialog.tsx");
    const preflight = runPreflight({ projectRoot: MACRO_FIXTURE, entries: [entry] });
    const expected = preflightFailureMessage(preflight.hard);

    await expect(explainProps(entry, {})).rejects.toThrow(expected);
  });
});

// hard hits append in discovery order; precedence must be checked by content, not list position.
describe("a component that reaches both a macro and a server boundary", () => {
  it("is still reported by the refusal that is not a transform", () => {
    const message = preflightFailureMessage([
      {
        kind: "unloadable-macro",
        chain: ["src/Dialog.tsx"],
        specifier: "@lingui/react/macro",
        transformCode: "babel-macro",
        transformOwner: "vite-plugin-babel-macros",
        transformOwnerDeclared: true,
      },
      { kind: "server-only", chain: ["src/Dialog.tsx"], specifier: "server-only" },
    ]);

    expect(message).toContain("imports the server-only marker package");
    expect(message).not.toContain("@lingui/react/macro");
  });
});
