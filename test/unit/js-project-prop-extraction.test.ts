import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractProps } from "../../src/prop-gen.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-jsproj-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// A JavaScript project is a first-class target: without allowJs the program has
// no source file for a .jsx component at all, so extraction could not even see
// the component.
describe("prop extraction for a JavaScript component", () => {
  it("extracts props from a .jsx component in a project with no config", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "js-app" }),
      "Card.jsx": `export function Card({ label, count }) { return <div>{label}{count}</div>; }\n`,
    });

    return expect(extractProps(path.join(dir, "Card.jsx"))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "label" }),
        expect.objectContaining({ name: "count" }),
      ]),
    );
  });

  it("extracts props from a .jsx component under a tsconfig that omits allowJs", async () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "js-app" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx" } }),
      "Card.jsx": `export function Card({ label }) { return <div>{label}</div>; }\n`,
    });

    const props = await extractProps(path.join(dir, "Card.jsx"));

    expect(props.map((p) => p.name)).toContain("label");
  });
});

describe("prop extraction under a jsconfig.json", () => {
  it("applies the paths declared in jsconfig.json", async () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "js-app" }),
      "jsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      "src/types.ts": `export interface CardProps { label: string; count?: number }\n`,
      "src/Card.tsx": `import type { CardProps } from "@/types";\nexport function Card(props: CardProps) { return <div>{props.label}</div>; }\n`,
    });

    const props = await extractProps(path.join(dir, "src", "Card.tsx"));

    expect(props.map((p) => p.name).sort()).toEqual(["count", "label"]);
  });

  it("warns about a malformed jsconfig.json and still extracts", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "js-app" }),
      "jsconfig.json": `{ "compilerOptions": { "paths": { `,
      "Card.tsx": `export function Card(props: { label: string }) { return <div>{props.label}</div>; }\n`,
    });

    const props = await extractProps(path.join(dir, "Card.tsx"));

    expect(props.map((p) => p.name)).toEqual(["label"]);
    const messages = write.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("jsconfig"));
    expect(messages).toHaveLength(1);
  });
});
