import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPreflight, recognizeTransform, declaredTransformOwner } from "../../src/preflight.js";

// directus: `app/src/lang/translations/en-US.yaml` is loaded by the
// `@rollup/plugin-yaml` its own vite.config declares. Vite cannot parse a YAML
// file without that plugin, so the run ended on a parse error that never named
// the plugin the project had all along.
const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "fixtures", "yaml-loader-project");

// The project's own SFC parser, reduced to the one thing the import walk reads:
// the script block's text.
const vueCompiler = {
  parse: (source: string) => {
    const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source);
    return { descriptor: { scriptSetup: match ? { content: match[1], lang: "ts" } : null } };
  },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-data-file-import-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("an import of a file type Vite cannot load on its own", () => {
  it("is a project-transform hit naming the loader the project declares", () => {
    const entry = path.join(FIXTURE, "src", "widget.tsx");

    const result = runPreflight({ projectRoot: FIXTURE, entries: [entry] });

    const hit = result.transforms.find((t) => t.specifier === "./messages.yaml");
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("project-transform");
    expect(hit?.transformCode).toBe("yaml");
    expect(hit?.transformOwner).toBe("@rollup/plugin-yaml");
  });

  it("keeps the generic wording when the project declares no loader", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
    fs.writeFileSync(path.join(tmpDir, "config.toml"), "a = 1\n");
    const entry = path.join(tmpDir, "Widget.tsx");
    fs.writeFileSync(entry, `import config from "./config.toml";\nexport const W = () => config;\n`);

    const result = runPreflight({ projectRoot: tmpDir, entries: [entry] });

    const hit = result.transforms.find((t) => t.specifier === "./config.toml");
    expect(hit?.transformCode).toBe("toml");
    expect(hit?.transformOwner).toContain("TOML loader plugin");
  });

  it("follows an SFC imported through a path alias to the data file behind it", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    );
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(
      path.join(tmpDir, "src", "Child.vue"),
      `<script setup lang="ts">\nimport messages from "./messages.yaml";\n</script>\n`,
    );
    fs.writeFileSync(path.join(tmpDir, "src", "messages.yaml"), "title: hello\n");
    const entry = path.join(tmpDir, "src", "Parent.vue");
    fs.writeFileSync(
      entry,
      `<script setup lang="ts">\nimport Child from "@/Child.vue";\n</script>\n`,
    );

    const result = runPreflight({ projectRoot: tmpDir, entries: [entry], vueCompiler });

    expect(result.transforms.map((t) => t.specifier)).toContain("./messages.yaml");
  });

  it("recognizes every extension Vite has no loader for", () => {
    expect(recognizeTransform("./en-US.yaml")?.code).toBe("yaml");
    expect(recognizeTransform("./en-US.yml")?.code).toBe("yaml");
    expect(recognizeTransform("./config.toml")?.code).toBe("toml");
    expect(recognizeTransform("./readme.md")?.code).toBe("markdown");
    expect(recognizeTransform("./query.graphql")?.code).toBe("graphql");
  });

  it("leaves a file type Vite serves itself alone", () => {
    expect(recognizeTransform("./page.mdx")?.code).toBe("mdx");
    expect(recognizeTransform("./data.json")).toBeUndefined();
  });

  it("names a declared GraphQL loader the same way", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "p", devDependencies: { "@rollup/plugin-graphql": "^2.0.0" } }),
    );

    expect(declaredTransformOwner("graphql", "./query.graphql", tmpDir, tmpDir)).toBe(
      "@rollup/plugin-graphql",
    );
  });
});
