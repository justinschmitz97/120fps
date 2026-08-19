import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SHIM_MODULES,
  buildShimAliases,
  unshimmedNextModules,
  UNSUPPORTED_NEXT_MODULE_WARNING,
} from "../../src/harness.js";

const SHIM_DIR = path.resolve(__dirname, "../../dist/shims");
const ADDED = ["next/script", "next/head", "next/router", "next/font/local"];

function loadShim(file: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(path.join(SHIM_DIR, file)).href);
}

describe("shim table coverage for common Next.js runtime modules", () => {
  it("answers the modules a real app imports beyond the original six", () => {
    const modules = SHIM_MODULES.map((s) => s.module);
    for (const added of ADDED) expect(modules).toContain(added);
  });

  it("gives every module its own alias", () => {
    const aliases = buildShimAliases(true);
    expect(aliases).toHaveLength(SHIM_MODULES.length);
    for (const added of ADDED) {
      expect(aliases.some((a) => a.find.test(added))).toBe(true);
    }
  });

  it("matches the exact specifier only", () => {
    const aliases = buildShimAliases(true);
    const router = aliases.find((a) => a.replacement.includes("next-router"))!;
    expect(router.find.test("next/router")).toBe(true);
    expect(router.find.test("next/router/x")).toBe(false);
    const font = aliases.find((a) => a.replacement.includes("next-font-local"))!;
    expect(font.find.test("next/font/local")).toBe(true);
    expect(font.find.test("next/font/google")).toBe(false);
  });

  it("emits every shim file to dist/shims", () => {
    for (const entry of SHIM_MODULES) {
      expect(fs.existsSync(path.join(SHIM_DIR, entry.shimFile)), entry.shimFile).toBe(true);
    }
  });
});

describe("next/script and next/head stand-ins", () => {
  it("render nothing, so no third-party script runs inside a measured window", async () => {
    const script = await loadShim("next-script.js");
    expect((script.default as (p: unknown) => unknown)({ src: "https://x/y.js" })).toBeNull();
  });

  it("keep document metadata out of the measured body", async () => {
    const head = await loadShim("next-head.js");
    expect((head.default as (p: unknown) => unknown)({ children: "title" })).toBeNull();
  });
});

describe("pages-router stand-in", () => {
  it("returns an inert router with the fields a component reads", async () => {
    const mod = await loadShim("next-router.js");
    const router = (mod.useRouter as () => Record<string, unknown>)();
    expect(router.pathname).toBe("/");
    expect(router.route).toBe("/");
    expect(router.asPath).toBe("/");
    expect(router.query).toEqual({});
    expect(router.isReady).toBe(true);
    for (const fn of ["push", "replace", "back", "forward", "reload", "prefetch"]) {
      expect(typeof router[fn], fn).toBe("function");
    }
    expect(() => (router.push as (u: string) => unknown)("/next")).not.toThrow();
  });

  it("exposes event subscription so a component's effect can attach", async () => {
    const mod = await loadShim("next-router.js");
    const events = (mod.useRouter as () => { events: Record<string, unknown> })().events;
    expect(typeof events.on).toBe("function");
    expect(typeof events.off).toBe("function");
  });

  it("default-exports the singleton router next/router ships", async () => {
    const mod = await loadShim("next-router.js");
    expect(typeof (mod.default as Record<string, unknown>).push).toBe("function");
  });
});

describe("next/font/local stand-in", () => {
  it("returns the class, variable, and style shape a component spreads", async () => {
    const mod = await loadShim("next-font-local.js");
    const font = (mod.default as (opts: unknown) => Record<string, unknown>)({
      src: "./Inter.woff2",
      variable: "--font-inter",
    });
    expect(font.className).toBe("");
    expect(font.variable).toBe("");
    expect(font.style).toEqual({});
  });
});

describe("unshimmed next/* modules", () => {
  it("names every scanned next subpath no shim answers", () => {
    expect(
      unshimmedNextModules(["next/image", "next/server", "next/cache", "react", "./local.css"]),
    ).toEqual(["next/cache", "next/server"]);
  });

  it("names next/font/google, which no static shim can answer", () => {
    expect(unshimmedNextModules(["next/font/local", "next/font/google"])).toEqual([
      "next/font/google",
    ]);
  });

  it("ignores the bare next specifier and unrelated packages that start with next", () => {
    expect(unshimmedNextModules(["next", "next-auth", "nextra/theme"])).toEqual([]);
  });

  it("reports nothing when every next import is shimmed", () => {
    expect(unshimmedNextModules(["next/link", "next/navigation", "next/head"])).toEqual([]);
  });

  it("warns without blocking, naming the modules", () => {
    const warning = UNSUPPORTED_NEXT_MODULE_WARNING(["next/cache", "next/server"]);
    expect(warning).toContain("next/cache");
    expect(warning).toContain("next/server");
    expect(warning).toContain("not shimmed");
  });
});
