import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import { presentBundlerFailure } from "../../src/harness/index.js";
import {
  bundledPreprocessor,
  classifyProjectTransformHits,
  findWorkspaceRoot,
  preflightFailureMessage,
  PROJECT_TRANSFORM_WARNING,
  runPreflight,
} from "../../src/project/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-sass-"));
  // Present but empty: without it every project here is refused as "no installed dependencies".
  fs.mkdirSync(path.join(tmpDir, "node_modules"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function installPackage(pkg: string): void {
  const dir = path.join(tmpDir, "node_modules", pkg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
}

function preflight(entry: string) {
  return runPreflight({ projectRoot: tmpDir, entries: [path.join(tmpDir, entry)] });
}

function classified(result: ReturnType<typeof preflight>) {
  return classifyProjectTransformHits(tmpDir, result.transforms, {
    workspaceRoot: findWorkspaceRoot(tmpDir),
  });
}

describe("the Sass implementation 120fps ships", () => {
  it("resolves, so a project without one still compiles", () => {
    const bundled = bundledPreprocessor(".scss");

    expect(bundled?.package).toBe("sass");
    expect(bundled?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is declared in this package's own dependencies, not found by accident", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8"));

    expect(manifest.dependencies.sass).toBeDefined();
  });

  it("covers .sass as well as .scss and nothing else", () => {
    expect(bundledPreprocessor(".sass")?.package).toBe("sass");
    expect(bundledPreprocessor(".less")).toBeUndefined();
    expect(bundledPreprocessor(".styl")).toBeUndefined();
  });
});

describe("a .scss import in a project that resolves no Sass", () => {
  beforeEach(() => {
    write("package.json", JSON.stringify({ name: "p", dependencies: {} }));
    write("theme.scss", ".a { color: red; }\n");
    write("Button.tsx", 'import "./theme.scss";\nexport default function Button() { return null; }\n');
  });

  it("is not a refusal: the run compiles with the bundled implementation", () => {
    expect(preflight("Button.tsx").hard).toEqual([]);
  });

  it("is disclosed as bundled, so the warning can name the version", () => {
    const hits = classified(preflight("Button.tsx"));

    expect(hits).toHaveLength(1);
    expect(hits[0].availability).toBe("bundled");
  });

  it("names the importing file, both packages, both roots and the version", () => {
    const { hit, availability } = classified(preflight("Button.tsx"))[0];

    const warning = PROJECT_TRANSFORM_WARNING(hit, availability);

    expect(warning).toContain("Button.tsx → ./theme.scss");
    expect(warning).toContain("sass");
    expect(warning).toContain("sass-embedded");
    expect(warning).toContain("workspace root");
    expect(warning).toContain(bundledPreprocessor(".scss")!.version);
    expect(warning).not.toContain("The import may fail to build");
  });

  it("discloses once however many .scss edges the graph has", () => {
    write("card.scss", ".b { color: blue; }\n");
    write("Card.tsx", 'import "./card.scss";\nexport const Card = () => null;\n');
    write(
      "Button.tsx",
      'import "./theme.scss";\nimport { Card } from "./Card";\nexport default function Button() { return Card; }\n',
    );

    expect(classified(preflight("Button.tsx"))).toHaveLength(1);
  });
});

describe("a .scss import in a project that resolves its own Sass", () => {
  it("changes nothing about the run: no disclosure, no refusal", () => {
    write("package.json", JSON.stringify({ name: "p", dependencies: { sass: "^1.90.0" } }));
    installPackage("sass");
    write("theme.scss", ".a { color: red; }\n");
    write("Button.tsx", 'import "./theme.scss";\nexport default function Button() { return null; }\n');

    const result = preflight("Button.tsx");

    expect(result.hard).toEqual([]);
    expect(classified(result)).toEqual([]);
  });
});

describe("a .less import, whose implementation 120fps does not ship", () => {
  beforeEach(() => {
    write("theme.less", "@c: red;\n");
    write("Button.tsx", 'import "./theme.less";\nexport default function Button() { return null; }\n');
  });

  it("is a hard preflight hit, so the refusal happens before a browser starts", () => {
    write("package.json", JSON.stringify({ name: "p", dependencies: {} }));

    const hit = preflight("Button.tsx").hard.find((h) => h.kind === "unavailable-preprocessor");

    expect(hit?.specifier).toBe("./theme.less");
    expect(hit?.preprocessor?.packages).toEqual(["less"]);
  });

  it("names the package, the directories searched and the install command", () => {
    write("package.json", JSON.stringify({ name: "p", dependencies: {} }));

    const message = preflightFailureMessage(preflight("Button.tsx").hard);

    expect(message).toContain("Button.tsx imports ./theme.less");
    expect(message).toContain("less");
    expect(message).toContain("node_modules");
    expect(message).toContain("npm install -D less");
  });

  it("tells a project that declares it to install rather than to add it", () => {
    write("package.json", JSON.stringify({ name: "p", dependencies: { less: "^4.0.0" } }));

    const message = preflightFailureMessage(preflight("Button.tsx").hard);

    expect(message).toContain("This project declares it, so its node_modules is out of date.");
    expect(message).toContain("npm install");
    expect(message).not.toContain("npm install -D less");
  });

  it("leaves a project that resolves less alone", () => {
    write("package.json", JSON.stringify({ name: "p", dependencies: {} }));
    installPackage("less");

    expect(preflight("Button.tsx").hard).toEqual([]);
  });

  it("names the same refusal in the dry run", async () => {
    write("package.json", JSON.stringify({ name: "p", dependencies: {} }));
    const expected = preflightFailureMessage(preflight("Button.tsx").hard);

    await expect(explainProps(path.join(tmpDir, "Button.tsx"), {})).rejects.toThrow(expected);
  });
});

// logto and vue-vben-admin, verbatim from smoke/run6-smoke1/logs/<repo>/real.log.
const LOGTO_FAILURE = [
  "component harness did not become ready within timeout. Page errors:",
  "  - [vite] Internal Server Error",
  'Preprocessor dependency "sass-embedded" not found. Did you install it? Try `npm install -D sass-embedded`.',
  "  - response 500: GET http://localhost:5173/src/ds-components/FormField/Skeleton.module.scss",
].join("\n");

const VBEN_FAILURE = [
  "component harness did not become ready within timeout. Page errors:",
  "  - [vite] Internal Server Error",
  'Preprocessor dependency "sass-embedded" not found. Did you install it? Try `npm install -D sass-embedded`.',
  "  - response 500: GET http://localhost:5173/@fs/E:/repositories-run6/vue-vben-admin/packages/effects/layouts/src/basic/header/header.vue?vue&type=style&index=0&scoped=6c3f90bb&lang.scss",
].join("\n");

describe("a preprocessor failure only the bundler saw", () => {
  beforeEach(() => {
    write("package.json", JSON.stringify({ name: "p" }));
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  });

  it("names the requesting file, both packages Vite tried and both directories it searched", () => {
    const message = presentBundlerFailure(LOGTO_FAILURE, tmpDir);

    expect(message).toContain("src/ds-components/FormField/Skeleton.module.scss");
    expect(message).toContain("sass-embedded");
    expect(message).toContain("sass");
    expect(message).toContain("its own installed copy");
    expect(message).not.toContain("Try `npm install -D sass-embedded`");
  });

  it("gives the install command in this repository's own package manager", () => {
    const message = presentBundlerFailure(LOGTO_FAILURE, tmpDir);

    expect(message).toContain("pnpm add -D sass");
    expect(message).not.toContain("npm install -D");
  });

  it("names a style block in a workspace sibling the import walk never entered", () => {
    const message = presentBundlerFailure(VBEN_FAILURE, tmpDir);

    expect(message).toContain("header.vue needs a CSS preprocessor");
  });

  it("leaves an unrelated harness failure byte-identical", () => {
    const other = "component harness did not become ready within timeout. No page errors were captured.";

    expect(presentBundlerFailure(other, tmpDir)).toBe(other);
  });
});
