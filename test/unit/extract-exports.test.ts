import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractExports, extractAllProps } from "../../src/prop-gen.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-exports-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("extractExports", () => {
  it("extracts named function exports", () => {
    const filePath = writeFixture("accordion.tsx", `
      import React from "react";
      export function Accordion(props: { children?: React.ReactNode }) { return <div>{props.children}</div>; }
      export function AccordionItem(props: { children?: React.ReactNode }) { return <div>{props.children}</div>; }
      export function AccordionTrigger(props: { children?: React.ReactNode }) { return <button>{props.children}</button>; }
      export function AccordionContent(props: { children?: React.ReactNode }) { return <div>{props.children}</div>; }
    `);
    return extractExports(filePath).then((exports) => {
      expect(exports).toHaveLength(4);
      expect(exports.map((e) => e.name).sort()).toEqual(
        ["Accordion", "AccordionContent", "AccordionItem", "AccordionTrigger"],
      );
      expect(exports.every((e) => !e.isDefault)).toBe(true);
    });
  });

  it("extracts named const exports", () => {
    const filePath = writeFixture("dialog.tsx", `
      import React from "react";
      export const Dialog = (props: { children?: React.ReactNode }) => <div>{props.children}</div>;
      export const DialogTrigger = (props: { children?: React.ReactNode }) => <button>{props.children}</button>;
    `);
    return extractExports(filePath).then((exports) => {
      expect(exports).toHaveLength(2);
      expect(exports.map((e) => e.name)).toContain("Dialog");
      expect(exports.map((e) => e.name)).toContain("DialogTrigger");
    });
  });

  it("identifies default export", () => {
    const filePath = writeFixture("default.tsx", `
      import React from "react";
      export default function Button(props: { label: string }) { return <button>{props.label}</button>; }
    `);
    return extractExports(filePath).then((exports) => {
      expect(exports).toHaveLength(1);
      expect(exports[0].name).toBe("Button");
      expect(exports[0].isDefault).toBe(true);
    });
  });

  it("skips non-component exports (lowercase)", () => {
    const filePath = writeFixture("utils.tsx", `
      import React from "react";
      export function Button(props: { label: string }) { return <button>{props.label}</button>; }
      export const helper = () => 42;
      export const MAX_COUNT = 10;
    `);
    return extractExports(filePath).then((exports) => {
      expect(exports).toHaveLength(1);
      expect(exports[0].name).toBe("Button");
    });
  });

  it("returns empty array for file with no exports", () => {
    const filePath = writeFixture("empty.tsx", `
      const x = 1;
    `);
    return extractExports(filePath).then((exports) => {
      expect(exports).toHaveLength(0);
    });
  });
});

describe("extractAllProps", () => {
  it("extracts props for each component export", () => {
    const filePath = writeFixture("multi-props.tsx", `
      import React from "react";
      export function Dialog(props: { open?: boolean; children?: React.ReactNode }) { return <div>{props.children}</div>; }
      export function DialogTrigger(props: { children?: React.ReactNode }) { return <button>{props.children}</button>; }
    `);
    return extractAllProps(filePath).then((schemas) => {
      expect(schemas.size).toBe(2);
      expect(schemas.has("Dialog")).toBe(true);
      expect(schemas.has("DialogTrigger")).toBe(true);
      const dialogProps = schemas.get("Dialog")!;
      expect(dialogProps.find((p) => p.name === "open")).toBeDefined();
      expect(dialogProps.find((p) => p.name === "children")).toBeDefined();
    });
  });
});
