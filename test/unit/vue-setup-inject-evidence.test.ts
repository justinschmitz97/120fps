import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  loadVueCompiler,
  parseSfcScript,
  vueCompilerLoadFailures,
  VUE_COMPILER_MISSING,
  type VueSfcCompiler,
} from "../../src/project/index.js";

const VUE_ROOT = path.resolve(__dirname, "../../fixtures/vue-project");
const INJECT = path.resolve(__dirname, "../../fixtures/vue-inject-context");

let compiler: VueSfcCompiler | undefined;

const parse = async (file: string) => {
  compiler ??= await loadVueCompiler(VUE_ROOT);
  const abs = path.join(INJECT, file);
  return parseSfcScript(fs.readFileSync(abs, "utf-8"), abs, compiler!);
};

// ark-F2: the run blamed a Vue plugin for a provide/inject failure. A hint may
// name a cause only from evidence the run read, so the parse records whether
// the measured setup block calls `inject(` at all.

describe("what a measured SFC's setup block reads", () => {
  it("records an inject call in the setup block", async () => {
    expect((await parse("UsesInject.vue"))?.usesInject).toBe(true);
  });

  it("records its absence for a setup block that injects nothing", async () => {
    expect((await parse("NoInject.vue"))?.usesInject).toBe(false);
  });

  it("does not count a commented-out inject call as read evidence", async () => {
    expect((await parse("CommentedInject.vue"))?.usesInject).toBe(false);
  });
});

// The compiler resolution failure the swallowed catch hid: two test files went
// red for weeks because `vue/compiler-sfc` resolved from nowhere and the loader
// returned undefined without saying why.

describe("a project the Vue compiler does not resolve from", () => {
  it("records why each specifier failed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-vue-"));

    try {
      expect(await loadVueCompiler(dir)).toBeUndefined();
      const failures = vueCompilerLoadFailures(dir);

      expect(failures.some((f) => f.startsWith("vue/compiler-sfc:"))).toBe(true);
      expect(failures.some((f) => f.startsWith("@vue/compiler-sfc:"))).toBe(true);
      expect(VUE_COMPILER_MISSING(dir)).toContain("vue/compiler-sfc:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
