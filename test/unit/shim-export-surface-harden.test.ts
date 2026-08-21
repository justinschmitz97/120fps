import { describe, it, expect } from "vitest";
import * as nextNavigation from "../../src/shims/next-navigation.js";
import * as nextImage from "../../src/shims/next-image.js";
import * as nextHeaders from "../../src/shims/next-headers.js";

// M96 harden: adversarial hypotheses against the new shim exports.

describe("M96 harden", () => {
  it("#1 ReadonlyURLSearchParams accepts a URLSearchParams instance as input", () => {
    const seed = new URLSearchParams("x=9");
    const params = new nextNavigation.ReadonlyURLSearchParams(seed);
    expect(params.get("x")).toBe("9");
  });

  it("#2 two useSearchParams() calls return independent instances", () => {
    const a = nextNavigation.useSearchParams();
    const b = nextNavigation.useSearchParams();
    expect(a).not.toBe(b);
  });

  it("#3 RedirectType members are the exact string values real Next.js uses", () => {
    expect(nextNavigation.RedirectType.push).toBe("push");
    expect(nextNavigation.RedirectType.replace).toBe("replace");
  });

  it("#4 permanentRedirect and redirect are both true no-ops (no navigation side effect)", () => {
    expect(() => nextNavigation.redirect("/a")).not.toThrow();
    expect(() => nextNavigation.permanentRedirect("/b")).not.toThrow();
    expect(nextNavigation.redirect("/a")).toBeUndefined();
  });

  it("#5 draftMode() returns a consistent shape across repeated calls", () => {
    const first = nextHeaders.draftMode();
    const second = nextHeaders.draftMode();
    expect(first).toEqual(second);
  });

  it("#6 getImageProps with fill:true produces the same absolute-position style as <Image>", () => {
    const result = nextImage.getImageProps({ src: "/a.png", fill: true });
    expect(result.props.style).toMatchObject({ position: "absolute", inset: 0 });
  });

  it("#7 getImageProps with no props at all does not crash", () => {
    expect(() => nextImage.getImageProps({})).not.toThrow();
  });

  it("#8 getImageProps preserves a caller-supplied style alongside fill", () => {
    const result = nextImage.getImageProps({ fill: true, style: { borderRadius: 8 } });
    expect((result.props.style as Record<string, unknown>).borderRadius).toBe(8);
  });

  it("#9 no required export resolves to undefined (a stricter check than key presence alone)", () => {
    const required: Record<string, string[]> = {
      "next/navigation": ["useRouter", "usePathname", "useSearchParams", "redirect", "notFound", "ReadonlyURLSearchParams"],
      "next/headers": ["cookies", "headers", "draftMode"],
      "next/image": ["default", "getImageProps"],
    };
    const modules: Record<string, Record<string, unknown>> = {
      "next/navigation": nextNavigation,
      "next/headers": nextHeaders,
      "next/image": nextImage,
    };
    for (const [mod, names] of Object.entries(required)) {
      for (const name of names) {
        expect(modules[mod][name], `${mod}.${name}`).toBeDefined();
      }
    }
  });

  it("#10 ReadonlyURLSearchParams still supports toString(), inherited unmodified", () => {
    const params = new nextNavigation.ReadonlyURLSearchParams("a=1&b=2");
    expect(params.toString()).toBe("a=1&b=2");
  });

  it("#11 useSearchParams() (no query in a bare harness mount) stays empty, unaffected by the class change", () => {
    const params = nextNavigation.useSearchParams();
    expect([...params.keys()]).toEqual([]);
  });

  it("#12 mutating methods throw a real Error/TypeError, not silently no-op", () => {
    const params = new nextNavigation.ReadonlyURLSearchParams();
    expect(() => params.sort()).toThrow(TypeError);
  });
});
