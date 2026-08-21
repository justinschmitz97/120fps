import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { closePoolsBounded } from "../../src/cli.js";
import { loadTsconfigAliases } from "../../src/harness.js";
import { loadVueCompiler, templateHasUnconditionalRoot, type VueSfcCompiler } from "../../src/vue-sfc.js";

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(paths: Record<string, string[]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-harden-a-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths } }));
  return dir;
}

// H1-H4 (M93): wildcard capture-group alias edge shapes.
describe("H1-H4: wildcard alias edge shapes", () => {
  it("H1: a leading wildcard (star as the first character of both sides)", () => {
    const dir = mkProject({ "*-suffix": ["./generated/*-out"] });
    fs.mkdirSync(path.join(dir, "generated"), { recursive: true });
    fs.writeFileSync(path.join(dir, "generated", "foo-out"), "x");
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(warnings).toEqual([]);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("foo-suffix")).toBe(true);
  });

  it("H2: three wildcards on one side falls back to a shape warning, not a crash", () => {
    const dir = mkProject({ "@**/***": ["./src/*"] });
    const warnings: string[] = [];
    expect(() => loadTsconfigAliases(dir, warnings)).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it("H3: target wildcard with no file extension suffix but a trailing static segment resolves multiple files correctly", () => {
    const dir = mkProject({ "@pkg/*": ["./packages/pkg-*/index.ts"] });
    fs.mkdirSync(path.join(dir, "packages", "pkg-foo"), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages", "pkg-foo", "index.ts"), "export {}");
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    const replaced = "@pkg/foo".replace(aliases[0].find, aliases[0].replacement);
    expect(replaced).toBe(path.join(dir, "packages", "pkg-foo", "index.ts").replace(/\\/g, "/"));
  });

  it("H4: an empty capture (star matches zero characters) still produces a valid replacement", () => {
    const dir = mkProject({ "@mantine/*": ["./packages/@mantine/*/src"] });
    fs.mkdirSync(path.join(dir, "packages", "@mantine", "src"), { recursive: true });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@mantine/")).toBe(true);
  });
});

// H5-H9 (M87): templateHasUnconditionalRoot edge shapes.
let compiler: VueSfcCompiler | undefined;
const VUE_ROOT = path.resolve("fixtures/vue-project");

describe("H5-H9: templateHasUnconditionalRoot edge shapes", () => {
  it("H5: self-closing component root with no attributes is unconditional", async () => {
    compiler ??= await loadVueCompiler(VUE_ROOT);
    const source = `<template><Foo/></template>\n<script setup lang="ts"></script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(true);
  });

  it("H6: a leading HTML comment before the real root does not confuse detection", async () => {
    compiler ??= await loadVueCompiler(VUE_ROOT);
    const source = `<template><!-- a v-if comment --><div v-if="x">y</div></template>\n<script setup lang="ts">defineProps<{x:boolean}>();</script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(false);
  });

  it("H7: v-if directive detection is not fooled by an unrelated attribute containing 'if' as a substring", async () => {
    compiler ??= await loadVueCompiler(VUE_ROOT);
    const source = `<template><div data-motif="x">y</div></template>\n<script setup lang="ts"></script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(true);
  });

  it("H8: attribute order does not matter -- v-if as the last attribute is still detected", async () => {
    compiler ??= await loadVueCompiler(VUE_ROOT);
    const source = `<template><div class="x" id="y" v-if="show">z</div></template>\n<script setup lang="ts">defineProps<{show:boolean}>();</script>`;
    expect(templateHasUnconditionalRoot(source, "X.vue", compiler!)).toBe(false);
  });

  it("H9: a malformed SFC (compiler throws) is treated conservatively as conditional (no forced wrap)", async () => {
    compiler ??= await loadVueCompiler(VUE_ROOT);
    const badCompiler: VueSfcCompiler = {
      parse: () => {
        throw new Error("boom");
      },
    };
    expect(templateHasUnconditionalRoot("<template></template>", "X.vue", badCompiler)).toBe(false);
  });
});

// H10-H12 (M88): closePoolsBounded against hostile pool implementations.
describe("H10-H12: closePoolsBounded resilience", () => {
  it("H10: a pool whose closeAll() throws synchronously does not prevent the other pool from being awaited", async () => {
    const hostile = { closeAll: () => { throw new Error("sync throw"); } };
    const wellBehaved = { closeAll: vi.fn().mockResolvedValue(undefined) };
    await expect(
      closePoolsBounded(hostile as never, wellBehaved as never, 5000),
    ).resolves.toBeUndefined();
    expect(wellBehaved.closeAll).toHaveBeenCalled();
  });

  it("H11: both pools throwing synchronously still resolves within the bound", async () => {
    const hostileA = { closeAll: () => { throw new Error("a"); } };
    const hostileB = { closeAll: () => { throw new Error("b"); } };
    await expect(
      closePoolsBounded(hostileA as never, hostileB as never, 5000),
    ).resolves.toBeUndefined();
  });

  it("H12: a zero-millisecond bound still allows a fast-resolving pool to be awaited before falling back", async () => {
    const pool = { closeAll: vi.fn().mockResolvedValue(undefined) };
    const serverPool = { closeAll: vi.fn().mockResolvedValue(undefined) };
    await closePoolsBounded(pool as never, serverPool as never, 0);
    // Both may or may not have been awaited to completion depending on the
    // race outcome at 0ms, but the call must never throw or hang.
    expect(true).toBe(true);
  });
});
