import { describe, it, expect, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { runPreflight, IMPORT_CYCLE_WARNING, NODE_BUILTIN_WARNING } from "../../src/preflight.js";
import {
  attachPageErrorCapture,
  enrichTimeoutError,
  setImportCycleReported,
  tdzCycleNote,
} from "../../src/page-errors.js";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-cycle-"));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// excalidraw: DropdownMenu -> DropdownMenuContent -> App -> LayerUI -> MainMenu
// -> DropdownMenu, with MainMenu reading DropdownMenu.Trigger at module scope.
function cyclicProject(): string {
  return mkProject({
    "package.json": JSON.stringify({ name: "app", dependencies: { react: "19.0.0" } }),
    "DropdownMenu.tsx": 'import { Content } from "./Content";\nexport const DropdownMenu = () => null;\nDropdownMenu.Content = Content;\n',
    "Content.tsx": 'import { MainMenu } from "./MainMenu";\nexport const Content = () => MainMenu;\n',
    "MainMenu.tsx": 'import { DropdownMenu } from "./DropdownMenu";\nconst Trigger = DropdownMenu.Trigger;\nexport const MainMenu = Trigger;\n',
  });
}

describe("an import graph that returns to the measured module", () => {
  it("is reported as a soft hit, so the run still proceeds", () => {
    const root = cyclicProject();
    const result = runPreflight({ projectRoot: root, entries: [path.join(root, "DropdownMenu.tsx")] });
    // A temp project has no node_modules, so preflight's install check fires;
    // what matters here is that the cycle itself is never a hard rejection.
    expect(result.hard.some((hit) => hit.kind === "import-cycle")).toBe(false);
    const cycle = result.soft.find((hit) => hit.kind === "import-cycle");
    expect(cycle).toBeDefined();
  });

  it("prints the hop chain back to the measured file", () => {
    const root = cyclicProject();
    const cycle = runPreflight({
      projectRoot: root,
      entries: [path.join(root, "DropdownMenu.tsx")],
    }).soft.find((hit) => hit.kind === "import-cycle")!;
    expect(cycle.chain[0]).toBe("DropdownMenu.tsx");
    expect(cycle.chain).toContain("MainMenu.tsx");
    expect(cycle.chain[cycle.chain.length - 1]).toBe("DropdownMenu.tsx");
  });

  it("names the cycle and the wrapper remedy, not the node-builtin text", () => {
    const root = cyclicProject();
    const cycle = runPreflight({
      projectRoot: root,
      entries: [path.join(root, "DropdownMenu.tsx")],
    }).soft.find((hit) => hit.kind === "import-cycle")!;
    const warning = NODE_BUILTIN_WARNING(cycle);
    expect(warning).toBe(IMPORT_CYCLE_WARNING(cycle));
    expect(warning).toContain("120fps.setup.tsx");
    expect(warning).toContain("--wrap");
    expect(warning).not.toContain("Node builtin");
  });

  it("reports one hit for a fan-in, listing every chain that returns", () => {
    const root = mkProject({
      "package.json": JSON.stringify({ name: "app" }),
      "Menu.tsx": ['import { A } from "./A";', 'import { B } from "./B";', "export const Menu = () => [A, B];"].join(String.fromCharCode(10)),
      "A.tsx": ['import { Menu } from "./Menu";', "export const A = Menu;"].join(String.fromCharCode(10)),
      "B.tsx": ['import { Menu } from "./Menu";', "export const B = Menu;"].join(String.fromCharCode(10)),
    });
    const cycles = runPreflight({
      projectRoot: root,
      entries: [path.join(root, "Menu.tsx")],
    }).soft.filter((hit) => hit.kind === "import-cycle");
    expect(cycles).toHaveLength(1);
    const warning = IMPORT_CYCLE_WARNING(cycles[0]);
    expect(warning).toContain("A.tsx");
    expect(warning).toContain("B.tsx");
  });

  it("does not claim the component's file is the graph's only root", () => {
    const root = cyclicProject();
    const cycle = runPreflight({
      projectRoot: root,
      entries: [path.join(root, "DropdownMenu.tsx")],
    }).soft.find((hit) => hit.kind === "import-cycle")!;
    // A --wrap module is an entry too (analyze passes [harnessPath, wrapPath]).
    expect(IMPORT_CYCLE_WARNING(cycle)).not.toContain("only root");
  });

  it("reports no cycle for an acyclic graph", () => {
    const root = mkProject({
      "package.json": JSON.stringify({ name: "app" }),
      "Button.tsx": 'import { label } from "./label";\nexport const Button = () => label;\n',
      "label.tsx": "export const label = 'x';\n",
    });
    const result = runPreflight({ projectRoot: root, entries: [path.join(root, "Button.tsx")] });
    expect(result.soft.some((hit) => hit.kind === "import-cycle")).toBe(false);
  });
});

describe("attributing a temporal-dead-zone page error", () => {
  function captureWith(text: string) {
    const emitter = new EventEmitter();
    const capture = attachPageErrorCapture(emitter as unknown as Page);
    emitter.emit("pageerror", new Error(text));
    return capture;
  }

  it("asserts the cycle only when preflight actually reported one", () => {
    const capture = captureWith("Cannot access 'DropdownMenu' before initialization");
    setImportCycleReported(false);
    const unproven = tdzCycleNote(capture)!;
    expect(unproven).toContain("DropdownMenu");
    expect(unproven).toContain("possibly an import cycle");
    expect(unproven).not.toContain("see the import-cycle warning above");
    setImportCycleReported(true);
    expect(tdzCycleNote(capture)!).toContain("see the import-cycle warning above");
  });

  it("is reset by the preflight walk that finds no cycle", () => {
    setImportCycleReported(true);
    const root = mkProject({
      "package.json": JSON.stringify({ name: "app" }),
      "Button.tsx": "export const Button = () => null;",
    });
    runPreflight({ projectRoot: root, entries: [path.join(root, "Button.tsx")] });
    const capture = captureWith("Cannot access 'X' before initialization");
    expect(tdzCycleNote(capture)!).toContain("possibly an import cycle");
  });

  it("is set by the preflight walk that finds one", () => {
    setImportCycleReported(false);
    const root = cyclicProject();
    runPreflight({ projectRoot: root, entries: [path.join(root, "DropdownMenu.tsx")] });
    const capture = captureWith("Cannot access 'DropdownMenu' before initialization");
    expect(tdzCycleNote(capture)!).toContain("see the import-cycle warning above");
  });

  it("names the binding and the cycle instead of a bare timeout", () => {
    setImportCycleReported(true);
    const capture = captureWith("Cannot access 'DropdownMenu' before initialization");
    const note = tdzCycleNote(capture)!;
    expect(note).toContain("DropdownMenu");
    expect(note).toContain("import cycle");
    const err = new Error("Timeout 30000ms exceeded.");
    err.name = "TimeoutError";
    expect(enrichTimeoutError(err, capture, "component harness").message).toContain(note);
  });

  it("says nothing for a page error of any other shape", () => {
    expect(tdzCycleNote(captureWith("useContext returned undefined"))).toBeUndefined();
  });
});
