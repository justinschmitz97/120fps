import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  CSS_FALLBACK_WARNING,
  discoverGlobalCss,
  findProjectEntry,
  readViteConfigData,
} from "../../src/harness/index.js";

const ROOT_PROJECT = path.resolve("fixtures/vite-root-project");
const COMPUTED_ROOT_PROJECT = path.resolve("fixtures/vite-root-computed");
const ROLLUP_INPUT_PROJECT = path.resolve("fixtures/vite-rollup-input");
const MIXED_ARGS_ROOT_PROJECT = path.resolve("fixtures/vite-root-mixed-args");

describe("a vite config that declares its own root", () => {
  it("folds a resolve() call into the directory it names", () => {
    expect(readViteConfigData(ROOT_PROJECT).root).toBe(path.join(ROOT_PROJECT, "dev"));
  });

  it("takes the entry from that directory's index.html", () => {
    expect(findProjectEntry(ROOT_PROJECT, { configRoot: path.join(ROOT_PROJECT, "dev") })).toBe(
      path.join(ROOT_PROJECT, "dev", "index.js"),
    );
  });

  it("resolves a root-absolute module script against the declared root", () => {
    const entry = findProjectEntry(ROOT_PROJECT, { configRoot: path.join(ROOT_PROJECT, "dev") });
    expect(entry).not.toBe(path.join(ROOT_PROJECT, "index.js"));
  });

  it("drops the no-application-entry clause from the fallback warning", () => {
    const warnings: string[] = [];
    const discovered = discoverGlobalCss(ROOT_PROJECT, warnings);
    expect(discovered.source).toBe("fallback");
    expect(discovered.files).toEqual([path.join(ROOT_PROJECT, "src", "theme.css")]);
    expect(discovered.noEntryInPackage).toBe(false);
    const fallback = warnings.find((w) => w.includes("was injected because it is"));
    expect(fallback).toBeDefined();
    expect(fallback).not.toContain("this package has no application entry");
  });

  it("keeps the other clauses of the fallback warning unchanged", () => {
    expect(CSS_FALLBACK_WARNING("src/theme.css", { onlyCandidate: true, noEntryInPackage: false })).toBe(
      "no entry stylesheet import and no conventional global stylesheet were found, so src/theme.css " +
        "was injected because it is the only stylesheet found under this project; pass --css to name " +
        "the right one",
    );
  });
});

describe("a vite config whose root cannot be folded", () => {
  it("names root among the ignored keys", () => {
    const data = readViteConfigData(COMPUTED_ROOT_PROJECT);
    expect(data.root).toBeUndefined();
    expect(data.ignoredKeys).toContain("root");
  });

  it("still reports no application entry, because none was found", () => {
    const warnings: string[] = [];
    const discovered = discoverGlobalCss(COMPUTED_ROOT_PROJECT, warnings);
    expect(discovered.noEntryInPackage).toBe(true);
    expect(warnings.join("\n")).toContain("this package has no application entry");
  });
});

describe("a vite config whose root call mixes literal and computed arguments", () => {
  it("ignores the root instead of folding the literal arguments alone", () => {
    const data = readViteConfigData(MIXED_ARGS_ROOT_PROJECT);
    expect(data.root).toBeUndefined();
    expect(data.ignoredKeys).toContain("root");
  });
});

describe("a vite config that declares a build entry", () => {
  it("folds a rollupOptions.input html path", () => {
    expect(readViteConfigData(ROLLUP_INPUT_PROJECT).rollupInputs).toEqual([
      path.join(ROLLUP_INPUT_PROJECT, "pages", "app.html"),
    ]);
  });

  it("takes the entry from that html file", () => {
    expect(
      findProjectEntry(ROLLUP_INPUT_PROJECT, {
        rollupInputs: [path.join(ROLLUP_INPUT_PROJECT, "pages", "app.html")],
      }),
    ).toBe(path.join(ROLLUP_INPUT_PROJECT, "pages", "main.js"));
  });

  it("decides the stylesheet on the entry chain, not on the size-ranked fallback", () => {
    const discovered = discoverGlobalCss(ROLLUP_INPUT_PROJECT);
    expect(discovered.source).toBe("entry");
    expect(discovered.files).toEqual([path.join(ROLLUP_INPUT_PROJECT, "src", "app.css")]);
  });
});
