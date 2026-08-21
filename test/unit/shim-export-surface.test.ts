import { describe, it, expect } from "vitest";
import * as nextNavigation from "../../src/shims/next-navigation.js";
import * as nextHeaders from "../../src/shims/next-headers.js";
import * as nextImage from "../../src/shims/next-image.js";
import * as nextLink from "../../src/shims/next-link.js";
import * as nextRouter from "../../src/shims/next-router.js";
import * as nextScript from "../../src/shims/next-script.js";
import * as nextDynamic from "../../src/shims/next-dynamic.js";
import * as nextFontLocal from "../../src/shims/next-font-local.js";
import * as nextHead from "../../src/shims/next-head.js";

// M96 (calcom-F2): cal.com's DatePicker hard-fails at build because
// 120fps's own next-navigation shim is missing `ReadonlyURLSearchParams`, a
// real (non-type-only) named export of `next/navigation`. This suite pins
// each shim's export surface against the real module's documented public
// API for the version range 120fps's shim set already targets, and adds a
// dedicated regression fixture for the calcom shape.

// One list per shimmed module: every named export the real module is
// documented to provide, for the App/Pages Router surface this shim set
// already targets. A shim exporting a strict superset (an extra runtime
// helper) is fine; a name missing from `Object.keys(shim)` fails the test.
const REQUIRED_EXPORTS: Record<string, string[]> = {
  "next/navigation": [
    "useRouter",
    "usePathname",
    "useSearchParams",
    "useParams",
    "useSelectedLayoutSegment",
    "useSelectedLayoutSegments",
    "redirect",
    "permanentRedirect",
    "notFound",
    "RedirectType",
    "ReadonlyURLSearchParams",
    "unstable_rethrow",
    "useServerInsertedHTML",
  ],
  "next/headers": ["cookies", "headers", "draftMode"],
  "next/image": ["default", "getImageProps"],
  "next/link": ["default"],
  "next/router": ["default", "useRouter", "withRouter"],
  "next/script": ["default"],
  "next/dynamic": ["default"],
  "next/font/local": ["default"],
  "next/head": ["default"],
};

const SHIMS: Record<string, Record<string, unknown>> = {
  "next/navigation": nextNavigation,
  "next/headers": nextHeaders,
  "next/image": nextImage,
  "next/link": nextLink,
  "next/router": nextRouter,
  "next/script": nextScript,
  "next/dynamic": nextDynamic,
  "next/font/local": nextFontLocal,
  "next/head": nextHead,
};

describe("M96: shim export surface matches the real module", () => {
  for (const [moduleName, required] of Object.entries(REQUIRED_EXPORTS)) {
    it(`${moduleName} shim exports every documented name`, () => {
      const shim = SHIMS[moduleName];
      const missing = required.filter((name) => !(name in shim));
      expect(missing).toEqual([]);
    });
  }
});

describe("M96: ReadonlyURLSearchParams (calcom-F2 regression)", () => {
  it("is a real runtime export, not undefined", () => {
    expect(nextNavigation.ReadonlyURLSearchParams).toBeDefined();
    expect(typeof nextNavigation.ReadonlyURLSearchParams).toBe("function");
  });

  it("useSearchParams() returns an instance of it", () => {
    const params = nextNavigation.useSearchParams();
    expect(params).toBeInstanceOf(nextNavigation.ReadonlyURLSearchParams);
  });

  it("is constructible directly, matching a component that builds one itself", () => {
    const params = new nextNavigation.ReadonlyURLSearchParams("a=1&b=2");
    expect(params.get("a")).toBe("1");
  });

  it("rejects mutation, matching the real read-only contract", () => {
    const params = new nextNavigation.ReadonlyURLSearchParams();
    expect(() => params.set("a", "1")).toThrow();
    expect(() => params.append("a", "1")).toThrow();
    expect(() => params.delete("a")).toThrow();
  });

  it("still supports read methods (a mutation-only override, not a broken class)", () => {
    const params = new nextNavigation.ReadonlyURLSearchParams("a=1");
    expect(params.get("a")).toBe("1");
    expect(params.has("a")).toBe(true);
    expect([...params.keys()]).toEqual(["a"]);
  });
});

describe("M96: new next/navigation exports behave inertly", () => {
  it("permanentRedirect is callable and does not throw", () => {
    expect(() => nextNavigation.permanentRedirect("/x")).not.toThrow();
  });

  it("RedirectType carries push/replace members, matching real Next.js usage", () => {
    expect(nextNavigation.RedirectType).toHaveProperty("push");
    expect(nextNavigation.RedirectType).toHaveProperty("replace");
  });

  it("useSelectedLayoutSegment returns null (no active segment in a bare harness mount)", () => {
    expect(nextNavigation.useSelectedLayoutSegment()).toBeNull();
  });

  it("useSelectedLayoutSegments returns an empty array", () => {
    expect(nextNavigation.useSelectedLayoutSegments()).toEqual([]);
  });

  it("unstable_rethrow is a no-op passthrough for a non-Next internal error", () => {
    const err = new Error("boom");
    expect(() => nextNavigation.unstable_rethrow(err)).not.toThrow();
  });
});

describe("M96: next/headers draftMode (audit-found gap)", () => {
  it("returns an object with isEnabled/enable/disable, matching the sync convention of its siblings", () => {
    const draft = nextHeaders.draftMode();
    expect(draft).toHaveProperty("isEnabled");
    expect(typeof draft.enable).toBe("function");
    expect(typeof draft.disable).toBe("function");
  });
});

describe("M96: next/image getImageProps (audit-found gap)", () => {
  it("returns a props object usable on a plain element", () => {
    const result = nextImage.getImageProps({ src: "/a.png", priority: true, quality: 75 });
    expect(result.props).toBeDefined();
    expect(result.props.src).toBe("/a.png");
    expect(result.props.loading).toBe("eager");
  });
});
