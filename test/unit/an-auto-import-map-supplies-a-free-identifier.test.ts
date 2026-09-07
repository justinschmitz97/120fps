import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  AUTO_IMPORT_DISCLOSURE,
  autoImportInjection,
  isAutoImportTarget,
  readAutoImportDeclarationMap,
} from "../../src/project/index.js";

const ROOT = path.resolve("fixtures/vue-auto-imports-map");
const NONE = path.resolve("fixtures/vue-no-generated-map");
const MAP = readAutoImportDeclarationMap(ROOT, ROOT)!;
const MODULE = path.join(ROOT, "src", "components", "UsesCounter.vue");

const inject = (source: string, file = MODULE) => autoImportInjection(source, file, MAP);

describe("reading an auto-import declaration map", () => {
  it("reads the identifiers a generated global block declares", () => {
    expect(path.resolve(MAP.file)).toBe(path.join(ROOT, "auto-imports.d.ts"));
    const counter = MAP.names.find((entry) => entry.name === "useCounter");
    expect(counter?.target).toBe("@vueuse/core");
    expect(counter?.exportName).toBe("useCounter");
    expect(MAP.names.find((entry) => entry.name === "ref")?.exportName).toBe("ref");
    // The generator also writes `(typeof import("m"))["Name"]`, which is the same entry.
    const toggle = MAP.names.find((entry) => entry.name === "useToggle");
    expect(toggle?.target).toBe("@vueuse/core");
    expect(toggle?.exportName).toBe("useToggle");
  });

  it("resolves an identifier the project's own source declares", () => {
    const local = MAP.names.find((entry) => entry.name === "useLocal");
    expect(local?.targetIsFile).toBe(true);
    expect(path.resolve(local!.target)).toBe(
      path.join(ROOT, "src", "composables", "useLocal.ts"),
    );
  });

  it("skips an identifier whose module is not on disk", () => {
    expect(MAP.names.map((entry) => entry.name)).not.toContain("useDeparted");
    expect(MAP.skipped).toContain("useDeparted");
  });

  it("reads nothing from a project that has no map", () => {
    expect(readAutoImportDeclarationMap(NONE, NONE)).toBeUndefined();
  });

  it("names the map and the counts in its disclosures", () => {
    expect(AUTO_IMPORT_DISCLOSURE(MAP.file, MAP.names.length)).toContain("auto-imports.d.ts");
    expect(AUTO_IMPORT_DISCLOSURE(MAP.file, MAP.names.length)).toContain(String(MAP.names.length));
  });
});

describe("supplying a free identifier to a module that references it", () => {
  it("prepends the import the map names", () => {
    const result = inject("const { count } = useCounter(0)\nexport default count\n");
    expect(result?.supplied).toEqual(["useCounter"]);
    expect(result?.code.startsWith('import { useCounter } from "@vueuse/core";')).toBe(true);
    expect(result?.code).toContain("const { count } = useCounter(0)");
  });

  it("points a local composable at its own file", () => {
    const result = inject("export const label = useLocal().label\n");
    expect(result?.supplied).toEqual(["useLocal"]);
    expect(result?.code).toMatch(/^import \{ useLocal \} from "\.\.\/composables\/useLocal(\.ts)?";/);
  });

  it("leaves a module that already imports the identifier untouched", () => {
    expect(
      inject('import { useCounter } from "@vueuse/core";\nconst c = useCounter(0)\n'),
    ).toBeUndefined();
  });

  it("leaves a module that declares the identifier itself untouched", () => {
    expect(inject("const useCounter = () => 0;\nexport default useCounter()\n")).toBeUndefined();
    expect(inject("function useCounter() { return 0 }\nexport default useCounter()\n")).toBeUndefined();
  });

  it("never shadows a binding declared in an inner scope", () => {
    expect(
      inject("export function make() { const useCounter = () => 1; return useCounter() }\n"),
    ).toBeUndefined();
  });

  it("ignores a name that only appears as a property or a string", () => {
    expect(inject('export const a = obj.useCounter;\nexport const b = "useCounter";\n')).toBeUndefined();
  });

  it("supplies nothing to a module that references no mapped name", () => {
    expect(inject("export const value = 1;\n")).toBeUndefined();
  });
});

describe("choosing which modules the transform may touch", () => {
  it("accepts a source file inside the project", () => {
    expect(isAutoImportTarget(MODULE, ROOT)).toBe(true);
    expect(isAutoImportTarget(path.join(ROOT, "src", "composables", "useLocal.ts"), ROOT)).toBe(true);
  });

  it("accepts the script block of a single-file component", () => {
    expect(isAutoImportTarget(`${MODULE}?vue&type=script&setup=true&lang.ts`, ROOT)).toBe(true);
  });

  it("refuses a file in node_modules", () => {
    expect(isAutoImportTarget(path.join(ROOT, "node_modules", "dep", "index.js"), ROOT)).toBe(false);
  });

  it("refuses a file outside the project", () => {
    expect(isAutoImportTarget(path.join(NONE, "Plain.vue"), ROOT)).toBe(false);
  });

  it("refuses a style block and a virtual module", () => {
    expect(isAutoImportTarget(`${MODULE}?vue&type=style&index=0&lang.css`, ROOT)).toBe(false);
    expect(isAutoImportTarget("\0virtual:something", ROOT)).toBe(false);
  });
});
