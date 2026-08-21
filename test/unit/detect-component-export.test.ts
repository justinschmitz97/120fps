import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectComponentExport } from "../../src/harness.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-detect-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("detectComponentExport", () => {
  it("picks export default function", () => {
    const file = writeFixture(
      "widget.tsx",
      `export default function Widget() { return null; }`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Widget",
      isDefaultOnly: true,
    });
  });

  it("picks export default class", () => {
    const file = writeFixture(
      "panel.tsx",
      `export default class Panel { render() { return null; } }`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Panel",
      isDefaultOnly: true,
    });
  });

  it("picks export default <Identifier>; (export assignment)", () => {
    const file = writeFixture(
      "card.tsx",
      `const Card = () => null;\nexport default Card;`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Card",
      isDefaultOnly: true,
    });
  });

  it("treats export { X as default } as a default import (isDefaultOnly true)", () => {
    const file = writeFixture(
      "toast.tsx",
      `function Toast() { return null; }\nexport { Toast as default };`,
    );
    // Old regex path returned isDefaultOnly: false, which generated
    // `import { Toast }` against a module with only a default export.
    expect(detectComponentExport(file)).toEqual({
      name: "Toast",
      isDefaultOnly: true,
    });
  });

  it("prefers the named export matching the file stem case-insensitively", () => {
    const file = writeFixture(
      "button.tsx",
      `export const Helper = () => null;
export const Zeta = () => null;
export function Button() { return null; }`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Button",
      isDefaultOnly: false,
    });
  });

  it("falls back to first PascalCase export in source order (const before function)", () => {
    const file = writeFixture(
      "misc.tsx",
      `export const Alpha = () => null;
export function Beta() { return null; }`,
    );
    // New contract: source order wins; the old regex cascade preferred
    // `export function` over `export const` regardless of order.
    expect(detectComponentExport(file)).toEqual({
      name: "Alpha",
      isDefaultOnly: false,
    });
  });

  it("default export beats file-stem match", () => {
    const file = writeFixture(
      "dialog.tsx",
      `export function Dialog() { return null; }
export default function Other() { return null; }`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Other",
      isDefaultOnly: true,
    });
  });

  it("picks first name from an export list when no default and no stem match", () => {
    const file = writeFixture(
      "pick.tsx",
      `const Foo = () => null;
const Bar = () => null;
export { Foo, Bar };`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Foo",
      isDefaultOnly: false,
    });
  });

  it("falls back to filename-derived default when no component exports exist", () => {
    const file = writeFixture("thing.tsx", `export const helper = 1;`);
    expect(detectComponentExport(file)).toEqual({
      name: "Thing",
      isDefaultOnly: true,
    });
  });

  it("anonymous default export falls back to filename with isDefaultOnly true", () => {
    const file = writeFixture(
      "anon.tsx",
      `export default function () { return null; }`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Anon",
      isDefaultOnly: true,
    });
  });

  it("ignores type-only exports", () => {
    const file = writeFixture(
      "types.tsx",
      `export type { Props } from "./x";
export { type Other } from "./y";`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Types",
      isDefaultOnly: true,
    });
  });

  it("named export that is also re-exported as default is importable as default", () => {
    const file = writeFixture(
      "combo.tsx",
      `export function Combo() { return null; }
export { Combo as default };`,
    );
    expect(detectComponentExport(file)).toEqual({
      name: "Combo",
      isDefaultOnly: true,
    });
  });
});

// chakra-ui declares the controlled variant first in every compound file
// (`tabs.ts:35` TabsRootProvider, `:52` TabsRoot), so source order alone
// measured the variant that additionally requires an externally-managed
// `value` object — for select/combobox, a class instance nothing synthesizes.
describe("choosing between a controlled provider export and its sibling", () => {
  it("prefers the sibling declared after a *Provider export", () => {
    const file = writeFixture(
      "tabs.ts",
      `export const TabsRootProvider = (props) => null;
export const TabsRoot = (props) => null;
export const TabsList = (props) => null;`,
    );
    expect(detectComponentExport(file)).toEqual({ name: "TabsRoot", isDefaultOnly: false });
  });

  it("keeps the *Provider export when the file has no other component", () => {
    const file = writeFixture(
      "only-provider.ts",
      `export const ThemeProvider = (props) => null;`,
    );
    expect(detectComponentExport(file)).toEqual({ name: "ThemeProvider", isDefaultOnly: false });
  });

  it("honours an explicit target naming the provider", () => {
    const file = writeFixture(
      "dialog.tsx",
      `export const DialogRootProvider = (props) => null;
export const DialogRoot = (props) => null;`,
    );
    expect(detectComponentExport(file, "DialogRootProvider")).toEqual({
      name: "DialogRootProvider",
      isDefaultOnly: false,
    });
  });

  it("does not second-guess a default-exported provider", () => {
    const file = writeFixture(
      "app-provider.tsx",
      `export const Inner = (props) => null;
export default function AppProvider() { return null; }`,
    );
    expect(detectComponentExport(file)).toEqual({ name: "AppProvider", isDefaultOnly: true });
  });

  it("does not second-guess a provider the file is named after", () => {
    const file = writeFixture(
      "mantine-provider.tsx",
      `export const MantineProvider = (props) => null;
export const Inner = (props) => null;`,
    );
    expect(detectComponentExport(file)).toEqual({ name: "MantineProvider", isDefaultOnly: false });
  });
});
