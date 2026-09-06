import { describe, it, expect } from "vitest";
import {
  classifyNavigationEscape,
  partitionExercisableTargets,
  type RawElement,
} from "../../src/browser/index.js";

const ORIGIN = "http://127.0.0.1:5173";

function raw(overrides: Partial<RawElement>): RawElement {
  return {
    tagName: "A",
    id: "",
    role: "",
    ariaLabel: "",
    ariaControls: "",
    ariaHaspopup: "",
    ariaExpanded: "",
    ariaValueNow: "",
    ariaOrientation: "",
    cursor: "pointer",
    tabindex: null,
    inputType: "",
    textContent: "link",
    dataTestid: "",
    hasOnclick: false,
    hasOnkeydown: false,
    hasOnkeyup: false,
    hasOnkeypress: false,
    hasOnmousedown: false,
    hasOnmouseup: false,
    scrollAxis: "",
    isContentEditable: false,
    isHidden: false,
    selector: "a",
    inShadow: false,
    ...overrides,
  };
}

const crossOrigin = raw({
  selector: "a:nth-of-type(1)",
  textContent: "Vite",
  href: "https://vite.dev/",
});
const newTab = raw({
  selector: "a:nth-of-type(2)",
  textContent: "Docs",
  href: `${ORIGIN}/docs`,
  linkTarget: "_blank",
});
const mailto = raw({
  selector: "a:nth-of-type(3)",
  textContent: "Mail us",
  href: "mailto:team@example.com",
});
const fragment = raw({
  selector: "a:nth-of-type(4)",
  textContent: "Skip to content",
  href: `${ORIGIN}/index.html#content`,
});
const route = raw({
  selector: "a:nth-of-type(5)",
  textContent: "Settings",
  href: `${ORIGIN}/settings`,
});
const button = raw({
  tagName: "BUTTON",
  selector: "button",
  textContent: "Toggle",
});

describe("an anchor that would leave the page is not exercised", () => {
  it("names a cross-origin href an external link", () => {
    expect(classifyNavigationEscape(crossOrigin, ORIGIN)).toBe("external-link");
  });

  it("names a same-origin target=_blank anchor a new-tab link", () => {
    expect(classifyNavigationEscape(newTab, ORIGIN)).toBe("new-tab-link");
  });

  it("names rel=external a link that leaves, even on the harness origin", () => {
    const external = raw({ href: `${ORIGIN}/away`, linkRel: "noopener external" });
    expect(classifyNavigationEscape(external, ORIGIN)).toBe("external-link");
  });

  it.each(["mailto:team@example.com", "tel:+4930123456", "javascript:void(0)"])(
    "names %s a non-http scheme",
    (href) => {
      expect(classifyNavigationEscape(raw({ href }), ORIGIN)).toBe("non-http-scheme");
    },
  );

  it("keeps a fragment anchor: the component owns where it scrolls to", () => {
    expect(classifyNavigationEscape(fragment, ORIGIN)).toBeUndefined();
  });

  it("keeps a same-origin route link: an app routes it itself", () => {
    expect(classifyNavigationEscape(route, ORIGIN)).toBeUndefined();
  });

  it("classifies nothing that is not an anchor", () => {
    expect(classifyNavigationEscape(button, ORIGIN)).toBeUndefined();
    expect(classifyNavigationEscape(raw({ tagName: "A", href: "" }), ORIGIN)).toBeUndefined();
  });

  it("keeps an anchor whose href does not parse rather than guessing it navigates", () => {
    expect(classifyNavigationEscape(raw({ href: "::::" }), ORIGIN)).toBeUndefined();
  });

  it("reads the attributes case-insensitively", () => {
    expect(classifyNavigationEscape(raw({ href: `${ORIGIN}/x`, linkTarget: "_BLANK" }), ORIGIN)).toBe(
      "new-tab-link",
    );
    expect(classifyNavigationEscape(raw({ href: `${ORIGIN}/x`, linkRel: "External" }), ORIGIN)).toBe(
      "external-link",
    );
  });

  it("counts a different port as a different origin", () => {
    expect(classifyNavigationEscape(raw({ href: "http://127.0.0.1:5174/x" }), ORIGIN)).toBe(
      "external-link",
    );
  });

  it("names the scheme before the origin, so a mailto is never called external", () => {
    expect(classifyNavigationEscape(raw({ href: "mailto:x@y.z", linkTarget: "_blank" }), ORIGIN)).toBe(
      "non-http-scheme",
    );
  });
});

describe("discovery hands the exploration loop only the targets it may exercise", () => {
  const page = [crossOrigin, newTab, mailto, fragment, route, button];

  it("yields the same-page anchors, the route link and the button", () => {
    const { exercisable } = partitionExercisableTargets(page, ORIGIN);
    expect(exercisable.map((e) => e.selector)).toEqual([
      fragment.selector,
      route.selector,
      button.selector,
    ]);
  });

  it("reports the three it declined with their reason class and href", () => {
    const { skipped } = partitionExercisableTargets(page, ORIGIN);
    expect(skipped).toEqual([
      { reason: "external-link", selector: crossOrigin.selector, label: "Vite", href: "https://vite.dev/" },
      { reason: "new-tab-link", selector: newTab.selector, label: "Docs", href: `${ORIGIN}/docs` },
      { reason: "non-http-scheme", selector: mailto.selector, label: "Mail us", href: "mailto:team@example.com" },
    ]);
  });

  it("leaves a page without external anchors exactly as it found it", () => {
    const inert = [fragment, route, button];
    const { exercisable, skipped } = partitionExercisableTargets(inert, ORIGIN);
    expect(exercisable).toEqual(inert);
    expect(skipped).toEqual([]);
  });
});
