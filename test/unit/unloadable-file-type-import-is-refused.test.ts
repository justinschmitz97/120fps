import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import { runPreflight, preflightFailureMessage } from "../../src/project/index.js";

// directus `app/src/components/v-button.vue`: five files deep the graph reaches
// `src/lang/translations/en-US.yaml`, which Vite parses as JavaScript because
// the harness never loads the project's `@rollup/plugin-yaml`. The run died on
// Vite's own `Failed to parse source for import analysis ... the .yaml file
// format` after a browser had already booted, and the dry run predicted a clean
// run. M94: a Vite failure is re-presented as a 120fps error naming target,
// importer and remedy, never a raw stack.

const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "fixtures", "yaml-loader-project");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function isolatedProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-unloadable-import-"));
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
  fs.writeFileSync(path.join(reactDom, "client.js"), "module.exports = {};\n");
  return root;
}

describe("an import of a file type no supported transform can load", () => {
  it("is a hard preflight hit, so the refusal happens before a browser starts", () => {
    const entry = path.join(FIXTURE, "src", "widget.tsx");

    const preflight = runPreflight({ projectRoot: FIXTURE, entries: [entry] });

    const hit = preflight.hard.find((h) => h.kind === "unloadable-file-type");
    expect(hit).toBeDefined();
    expect(hit?.specifier).toBe("./messages.yaml");
    expect(hit?.transformCode).toBe("yaml");
    expect(hit?.transformOwner).toBe("@rollup/plugin-yaml");
  });

  it("stays in the transform list, so --no-preflight still names the plugin", () => {
    const entry = path.join(FIXTURE, "src", "widget.tsx");

    const preflight = runPreflight({ projectRoot: FIXTURE, entries: [entry] });

    expect(preflight.transforms.map((h) => h.specifier)).toContain("./messages.yaml");
  });

  it("names the importer, the import, the project's plugin and the way out", () => {
    const entry = path.join(FIXTURE, "src", "widget.tsx");
    const preflight = runPreflight({ projectRoot: FIXTURE, entries: [entry] });

    const message = preflightFailureMessage(preflight.hard);

    expect(message).toContain("src/widget.tsx");
    expect(message).toContain("./messages.yaml");
    expect(message).toContain("@rollup/plugin-yaml");
    expect(message).toContain("120fps loads only its supported transforms (svgr, vanilla-extract, vue)");
    expect(message).toContain("fixture");
    expect(message).toContain("--wrap");
    expect(message).not.toContain("Failed to parse source");
  });

  it("keeps the recognizer's generic owner when the project declares no loader", () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({ name: "p", dependencies: { react: "19.0.0" } }),
      "config.toml": "a = 1\n",
      "Widget.tsx": 'import config from "./config.toml";\nexport const Widget = () => config;\n',
    });

    const preflight = runPreflight({ projectRoot: root, entries: [path.join(root, "Widget.tsx")] });

    const hit = preflight.hard.find((h) => h.kind === "unloadable-file-type");
    expect(hit?.transformCode).toBe("toml");
    expect(hit?.transformOwnerDeclared).toBeUndefined();
    // M92: every printed sentence is true of this project. It declares no
    // loader, so the message may not say it compiles the file with one.
    const message = preflightFailureMessage(preflight.hard);
    expect(message).toContain(
      "Nothing in this project declares a TOML loader plugin (e.g. @rollup/plugin-toml), " +
        "which Vite needs to load it.",
    );
    expect(message).not.toContain("This project compiles that with");
  });

  it("leaves a transform the run applies or Vite resolves itself alone", () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({ name: "p", dependencies: { react: "19.0.0" } }),
      "card.scss": ".card { color: red; }\n",
      "Card.tsx": "import './card.scss';\nexport const Card = () => null;\n",
    });

    const preflight = runPreflight({ projectRoot: root, entries: [path.join(root, "Card.tsx")] });

    expect(preflight.hard).toEqual([]);
  });
});

// The project's own SFC parser, reduced to the one thing the import walk reads.
const vueCompiler = {
  parse: (source: string) => {
    const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source);
    return { descriptor: { scriptSetup: match ? { content: match[1], lang: "ts" } : null } };
  },
};

describe("the same import reached through a chain of SFCs", () => {
  it("is refused by the file that imports it, not by the measured component", () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({ name: "p", devDependencies: { "@rollup/plugin-yaml": "^4.1.2" } }),
      "src/Parent.vue": '<script setup lang="ts">\nimport Child from "./Child.vue";\n</script>\n',
      "src/Child.vue": '<script setup lang="ts">\nimport messages from "./messages.yaml";\n</script>\n',
      "src/messages.yaml": "title: hello\n",
    });

    const preflight = runPreflight({
      projectRoot: root,
      entries: [path.join(root, "src", "Parent.vue")],
      vueCompiler,
    });

    const message = preflightFailureMessage(preflight.hard);
    expect(message).toContain("src/Child.vue imports ./messages.yaml");
    expect(message).toContain("src/Parent.vue → src/Child.vue → ./messages.yaml");
  });

  it("is invisible to a walk with no SFC parser, which is why the dry run loads one", () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({ name: "p" }),
      "src/Parent.vue": '<script setup lang="ts">\nimport Child from "./Child.vue";\n</script>\n',
      "src/Child.vue": '<script setup lang="ts">\nimport messages from "./messages.yaml";\n</script>\n',
      "src/messages.yaml": "title: hello\n",
    });

    const preflight = runPreflight({
      projectRoot: root,
      entries: [path.join(root, "src", "Parent.vue")],
    });

    expect(preflight.hard).toEqual([]);
  });
});

describe("the dry run's prediction of that refusal", () => {
  it("refuses with the same string the real run's preflight gate throws", async () => {
    const entry = path.join(FIXTURE, "src", "widget.tsx");
    const preflight = runPreflight({ projectRoot: FIXTURE, entries: [entry] });
    const expected = preflightFailureMessage(preflight.hard);

    await expect(explainProps(entry, {})).rejects.toThrow(expected);
  });

  it("predicts the refusal before it asks whether react-dom is installed", async () => {
    const entry = path.join(FIXTURE, "src", "widget.tsx");

    await expect(explainProps(entry, {})).rejects.toThrow("./messages.yaml");
  });
});

// A refusal that is not this one names an edge that fails before Vite reaches
// the data file, and the promotion above appends to `hard` after every hit the
// walk already found (both call sites then append composed-child hits after
// that), so precedence cannot be positional.
describe("a component that reaches both a data file and an earlier refusal", () => {
  it("is still reported by the refusal that is not the data file", () => {
    const message = preflightFailureMessage([
      {
        kind: "unloadable-file-type",
        chain: ["src/Widget.tsx"],
        specifier: "./messages.yaml",
        transformCode: "yaml",
        transformOwner: "@rollup/plugin-yaml",
        transformOwnerDeclared: true,
      },
      { kind: "async-component", chain: ["src/Widget.tsx"] },
    ]);

    expect(message).toContain("exports an async function component");
    expect(message).not.toContain("./messages.yaml");
  });
});

// The dry run reads a Vue graph only through the project's own SFC parser, so
// what it finds two SFCs down is pinned by behaviour, not by a source grep.
// (The refusal when no compiler resolves has its own file:
// vue-target-without-sfc-compiler-is-refused.test.ts.)
describe("the dry run on a real Vue project", () => {
  const VUE_FIXTURE = path.resolve(import.meta.dirname, "..", "..", "fixtures", "vue-project");

  it("reaches a data-file import two SFCs down and names the whole chain", async () => {
    const error = await explainProps(path.join(VUE_FIXTURE, "YamlLeak.vue")).catch(
      (e: Error) => e,
    );

    expect(error.message).toContain("YamlChild.vue imports ./data.yaml");
    expect(error.message).toContain("YamlLeak.vue → YamlChild.vue → ./data.yaml");
  });
});

// The run path needs a browser to reach a report, so what is pinned here is
// that it refuses through the same gate with the same message builder.
describe("the run path's own refusal", () => {
  const analyzeSrc = fs.readFileSync(path.resolve("src/pipeline/analyze.ts"), "utf-8");

  it("throws the shared preflight message for every hard hit", () => {
    const phasesSrc = fs.readFileSync(path.resolve("src/pipeline/phases.ts"), "utf-8");
    expect(phasesSrc).toContain(
      "throw new PreflightHardRejectionError(preflightFailureMessage(preflight.hard));",
    );
  });

  // directus `src/components/v-button.vue`: the run path walks the graph with
  // the project's SFC parser and reached the `.yaml` five files down; the dry
  // run walked without one, stopped at the first `.vue` import and predicted a
  // clean run. Both call sites now load the same compiler.
  it("walks a Vue graph with the same compiler the dry run loads", () => {
    const explainSrc = fs.readFileSync(path.resolve("src/pipeline/explain-props.ts"), "utf-8");
    const explain = explainSrc.slice(
      explainSrc.indexOf("export async function explainProps"),
      explainSrc.indexOf("preflight.hard.push(...composedChildPreflightHits(resolvedPath"),
    );
    expect(explain).toContain(
      'const vueCompiler = framework === "vue" ? await loadVueCompiler(projectRoot) : undefined;',
    );
    expect(explain).toContain("...(vueCompiler ? { vueCompiler } : {}),");
  });
});
