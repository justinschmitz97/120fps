import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { filterProjectModuleTypeWarnings } from "../../src/cli/index.js";

// The listener replaces Node's own default handler, so each case is checked through a stub.
function emitted(warnings: Array<Record<string, unknown>>): string[] {
  const seen: string[] = [];
  const original = process.listeners("warning").slice();
  for (const listener of original) process.removeListener("warning", listener);
  process.on("warning", ((warning: Error) => {
    seen.push(warning.message);
  }) as (warning: Error) => void);
  try {
    filterProjectModuleTypeWarnings(path.resolve("/opt/tools/120fps"));
    for (const warning of warnings) {
      const error = new Error(String(warning.message)) as Error & Record<string, unknown>;
      error.name = "Warning";
      for (const [key, value] of Object.entries(warning)) {
        if (key !== "message") error[key] = value;
      }
      process.emit("warning", error);
    }
  } finally {
    for (const listener of process.listeners("warning")) {
      process.removeListener("warning", listener);
    }
    for (const listener of original) process.on("warning", listener as (warning: Error) => void);
  }
  return seen;
}

const TYPELESS = (file: string): Record<string, unknown> => ({
  code: "MODULE_TYPELESS_PACKAGE_JSON",
  message:
    `Module type of ${pathToFileURL(file).href} is not specified and it doesn't parse as ` +
    "CommonJS. Reparsing as ES module because module syntax was detected.",
});

describe("a Node warning about a file in the measured project", () => {
  it("does not reach the terminal", () => {
    expect(emitted([TYPELESS(path.resolve("/tmp/project/tailwind.config.ts"))])).toEqual([]);
  });

  it("still reaches the terminal when the file is inside 120fps's own tree", () => {
    const own = path.resolve("/opt/tools/120fps", "dist", "shims", "next-font.js");
    expect(emitted([TYPELESS(own)])).toHaveLength(1);
  });
});

describe("every other Node warning", () => {
  it("is re-emitted unchanged", () => {
    const experimental = {
      code: "ExperimentalWarning",
      message: "VM Modules is an experimental feature",
    };
    expect(emitted([experimental])).toEqual(["VM Modules is an experimental feature"]);
  });

  it("is re-emitted even when it names a project file", () => {
    const other = {
      code: "DEP0040",
      message: "The `punycode` module is deprecated (/tmp/project/postcss.config.js)",
    };
    expect(emitted([other])).toHaveLength(1);
  });
});

describe("the filter itself", () => {
  it("installs one listener however often it is called", () => {
    const original = process.listeners("warning").slice();
    for (const listener of original) process.removeListener("warning", listener);
    process.on("warning", (() => {}) as (warning: Error) => void);
    try {
      filterProjectModuleTypeWarnings(path.resolve("/opt/tools/120fps"));
      expect(process.listenerCount("warning")).toBe(1);
      filterProjectModuleTypeWarnings(path.resolve("/opt/tools/120fps"));
      expect(process.listenerCount("warning")).toBe(1);
    } finally {
      for (const listener of process.listeners("warning")) {
        process.removeListener("warning", listener);
      }
      for (const listener of original) process.on("warning", listener as (warning: Error) => void);
    }
  });
});
