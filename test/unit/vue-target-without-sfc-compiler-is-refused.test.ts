import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// M110: the run path refuses a `.vue` target whose project resolves no SFC
// compiler (src/analyze.ts, M57). Without the same gate the dry run walked past
// every SFC edge blind and predicted a clean run for a component the run would
// refuse outright. The compiler resolves from any directory under the test
// runner, so the missing one is supplied by a module mock rather than a
// fixture.
vi.mock("../../src/project/vue-sfc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/project/vue-sfc.js")>();
  return { ...actual, loadVueCompiler: async () => undefined };
});

const { explainProps } = await import("../../src/pipeline/index.js");
const { VUE_COMPILER_MISSING } = await import("../../src/project/index.js");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("a .vue target in a project with no SFC compiler", () => {
  it("is refused by the dry run, the same way the run refuses it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-no-sfc-compiler-"));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p" }));
    fs.writeFileSync(
      path.join(root, "Parent.vue"),
      '<script setup lang="ts">\nimport messages from "./messages.yaml";\n</script>\n',
    );
    fs.writeFileSync(path.join(root, "messages.yaml"), "title: hello\n");

    await expect(explainProps(path.join(root, "Parent.vue"))).rejects.toThrow(
      VUE_COMPILER_MISSING(root),
    );
  });
});
