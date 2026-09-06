import { describe, it, expect } from "vitest";
import { SKIPPED_TARGETS_NOTICE, type SkippedTarget } from "../../src/browser/index.js";

function skip(reason: SkippedTarget["reason"], selector: string): SkippedTarget {
  return { reason, selector, label: selector };
}

describe("the exploration report says how many targets it declined and why", () => {
  it("prints nothing when every discovered target was exercised", () => {
    expect(SKIPPED_TARGETS_NOTICE([])).toBeUndefined();
  });

  it("counts the targets and names each reason class", () => {
    const notice = SKIPPED_TARGETS_NOTICE([
      skip("external-link", "a1"),
      skip("external-link", "a2"),
      skip("new-tab-link", "a3"),
      skip("non-http-scheme", "a4"),
    ]);
    expect(notice).toContain("4 interaction targets");
    expect(notice).toContain("2 external links");
    expect(notice).toContain("1 new-tab link");
    expect(notice).toContain("1 non-http link");
  });

  it("stays singular for a single skipped target", () => {
    const notice = SKIPPED_TARGETS_NOTICE([skip("external-link", "a1")]);
    expect(notice).toContain("1 interaction target ");
    expect(notice).toContain("1 external link");
    expect(notice).not.toContain("external links");
  });

  it("says the cost belongs to the browser, not the component", () => {
    const notice = SKIPPED_TARGETS_NOTICE([skip("external-link", "a1")])!;
    expect(notice).toMatch(/leave the page/);
    expect(notice).toMatch(/not the component/);
  });

  it("counts a target the click itself proved was leaving the page", () => {
    const notice = SKIPPED_TARGETS_NOTICE([
      skip("opened-a-page", "a1"),
      skip("left-the-page", "a2"),
    ])!;
    expect(notice).toContain("1 link that opened a new page");
    expect(notice).toContain("1 link that left the harness page");
  });

  it("is identical for two combos that skipped the same classes, so the run prints one line", () => {
    const first = SKIPPED_TARGETS_NOTICE([skip("external-link", "a1"), skip("new-tab-link", "a2")]);
    const second = SKIPPED_TARGETS_NOTICE([skip("external-link", "b1"), skip("new-tab-link", "b2")]);
    expect(first).toBe(second);
  });
});
