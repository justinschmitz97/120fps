import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractProps, extractAllProps } from "../../src/prop-gen.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkFixture(tsconfig: string): { dir: string; component: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-pgwarn-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "tsconfig.json"), tsconfig);
  const component = path.join(dir, "comp.tsx");
  fs.writeFileSync(
    component,
    `export function Comp(props: { label: string; count?: number }) { return null; }`,
  );
  return { dir, component };
}

function tsconfigWarnings(write: ReturnType<typeof vi.spyOn>): string[] {
  return write.mock.calls
    .map((c) => String(c[0]))
    .filter((s) => s.includes("tsconfig"));
}

describe("prop-gen tsconfig warnings", () => {
  it("malformed tsconfig: extraction still works, warns once across two calls", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { component } = mkFixture(`{ "compilerOptions": { "paths": { `);

    const first = await extractProps(component);
    const second = await extractProps(component);

    expect(first.map((p) => p.name).sort()).toEqual(["count", "label"]);
    expect(second.map((p) => p.name).sort()).toEqual(["count", "label"]);
    expect(tsconfigWarnings(write)).toHaveLength(1);
  });

  it("tsconfig with invalid option values: warns once, options still applied", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { component } = mkFixture(
      JSON.stringify({ compilerOptions: { strict: "yes" } }),
    );

    const props = await extractProps(component);
    await extractProps(component);

    expect(props.map((p) => p.name).sort()).toEqual(["count", "label"]);
    expect(tsconfigWarnings(write)).toHaveLength(1);
  });

  it("warning is shared across extractProps and extractAllProps for the same config", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { component } = mkFixture(`not json at all <<<`);

    await extractProps(component);
    const all = await extractAllProps(component);

    expect(all.has("Comp")).toBe(true);
    expect(tsconfigWarnings(write)).toHaveLength(1);
  });

  it("valid tsconfig produces no warning", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { component } = mkFixture(
      JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx" } }),
    );

    const props = await extractProps(component);
    expect(props.map((p) => p.name).sort()).toEqual(["count", "label"]);
    expect(tsconfigWarnings(write)).toHaveLength(0);
  });
});
