import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractProps, type PropSchema } from "../../src/props/index.js";

const REFERENCES = path.resolve("fixtures/tsconfig-shapes/project-references");
const BUTTON = path.join(REFERENCES, "src", "components", "Button.tsx");

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-reader-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function shape(props: PropSchema[]): Array<{ name: string; kind: string; required: boolean }> {
  return props
    .map((prop) => ({ name: prop.name, kind: prop.kind, required: prop.required }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Control: the manual inline-compilerOptions fix a user is told to do; extraction must match it.
function controlTree(): string {
  const dir = mkProject({
    "package.json": JSON.stringify({ name: "control", private: true, type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        baseUrl: ".",
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src"],
    }),
    "src/lib/utils.ts": fs.readFileSync(path.join(REFERENCES, "src", "lib", "utils.ts"), "utf8"),
    "src/components/Button.tsx": fs.readFileSync(BUTTON, "utf8"),
  });
  return path.join(dir, "src", "components", "Button.tsx");
}

// coordinator-F1: vite's split tsconfig (paths in tsconfig.app.json) hid aliased props.
describe("prop extraction reads the config that governs the component", () => {
  it("resolves an alias only the referenced config declares, so the aliased props appear", async () => {
    const props = await extractProps(BUTTON);

    expect(shape(props)).toEqual([
      { name: "disabled", kind: "boolean", required: false },
      { name: "label", kind: "string", required: true },
      { name: "variant", kind: "union", required: false },
    ]);
  });

  it("matches the control tree that inlines the same compilerOptions", async () => {
    const viaReferences = await extractProps(BUTTON);
    const inlined = await extractProps(controlTree());

    expect(shape(viaReferences)).toEqual(shape(inlined));
    const variant = viaReferences.find((prop) => prop.name === "variant");
    expect(variant?.values).toEqual(
      inlined.find((prop) => prop.name === "variant")?.values,
    );
    expect(variant?.values).toEqual(["solid", "ghost"]);
  });
});

// B2: the reader is not allowed to turn a bad config into a failed run.
describe("a config the reader cannot read", () => {
  it("warns once per config path and extracts on the built-in defaults", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "unreadable", private: true }),
      "tsconfig.json": `{ "compilerOptions": { "paths": { `,
      "comp.tsx": `export function Comp(props: { label: string; count?: number }) { return null; }`,
    });
    const component = path.join(dir, "comp.tsx");

    const first = await extractProps(component);
    const second = await extractProps(component);

    expect(first.map((prop) => prop.name).sort()).toEqual(["count", "label"]);
    expect(second.map((prop) => prop.name).sort()).toEqual(["count", "label"]);
    expect(
      write.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("tsconfig")),
    ).toHaveLength(1);
  });

  it("says nothing on stderr about the references handover, which the run discloses once", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await extractProps(BUTTON);

    expect(
      write.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("declares no compilerOptions and lists references")),
    ).toEqual([]);
  });
});
