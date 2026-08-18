import { describe, it, expect } from "vitest";
import {
  CALLBACK_PROPS_SOURCE,
  computeCallbackIdentityDelta,
  generateProbeEntry,
} from "../../src/react-profiler.js";

const MARKER = "__120fps_fn__";

// The builder ships to the browser as source; evaluating it here tests the real
// thing rather than a copy.
function loadBuilder(): (
  props: Record<string, unknown>,
  cache: Map<string, unknown>,
  marker: string,
  measured: string | null,
  fresh: boolean,
) => Record<string, unknown> {
  return new Function(`${CALLBACK_PROPS_SOURCE}; return __120fpsCallbackProps;`)();
}

describe("M66: callback props builder", () => {
  it("turns every function marker into the cached callback", () => {
    const build = loadBuilder();
    const cache = new Map<string, unknown>();
    const a = build({ onClick: MARKER, onBlur: MARKER, label: "x" }, cache, MARKER, null, false);
    const b = build({ onClick: MARKER, onBlur: MARKER, label: "x" }, cache, MARKER, null, false);
    expect(typeof a.onClick).toBe("function");
    expect(a.onClick).toBe(b.onClick);
    expect(a.onBlur).toBe(b.onBlur);
    expect(a.onClick).not.toBe(a.onBlur);
    expect(a.label).toBe("x");
  });

  it("installs the measured prop even when the combo omits it", () => {
    const build = loadBuilder();
    const cache = new Map<string, unknown>();
    const mounted = build({}, cache, MARKER, "dispatch", false);
    const stable = build({}, cache, MARKER, "dispatch", false);
    expect(typeof mounted.dispatch).toBe("function");
    expect(stable.dispatch).toBe(mounted.dispatch);
  });

  it("gives the fresh arm a new function on every call", () => {
    const build = loadBuilder();
    const cache = new Map<string, unknown>();
    const mounted = build({}, cache, MARKER, "dispatch", false);
    const fresh1 = build({}, cache, MARKER, "dispatch", true);
    const fresh2 = build({}, cache, MARKER, "dispatch", true);
    expect(fresh1.dispatch).not.toBe(mounted.dispatch);
    expect(fresh2.dispatch).not.toBe(fresh1.dispatch);
  });

  it("leaves non-function props alone", () => {
    const build = loadBuilder();
    const out = build(
      { count: 3, items: [1, 2], flag: false, text: "hello" },
      new Map(),
      MARKER,
      null,
      false,
    );
    expect(out).toEqual({ count: 3, items: [1, 2], flag: false, text: "hello" });
  });

  it("is wired into the probe entry for mount and both arms", () => {
    const entry = generateProbeEntry({
      componentRelative: "src/Button.tsx",
      componentName: "Button",
      isDefaultExport: true,
    });
    expect(entry).toContain("__120fpsCallbackProps");
    expect(entry).toContain("mountWithStableCallbacks");
    expect(entry).toContain("rerenderWithStableCallbacks");
    expect(entry).toContain("rerenderWithFreshCallbacks");
  });
});

describe("M66: callback identity significance", () => {
  it("reports an effect that clears both arms' scatter", () => {
    const result = computeCallbackIdentityDelta([12, 13, 12.5], [290, 305, 296]);
    expect(result).not.toBeNull();
    expect(result!.deltaMs).toBeCloseTo(296 - 12.5, 5);
    expect(result!.stableMs).toBeCloseTo(12.5, 5);
    expect(result!.freshMs).toBeCloseTo(296, 5);
  });

  it("rejects the A/A control that produced the dogfood false positive", () => {
    // Measured on fixtures/m66-callback-sensitive.tsx with both arms rendering
    // the stable callback: identical treatment, +18.1ms apparent effect.
    expect(
      computeCallbackIdentityDelta(
        [268.51, 255.779, 285.561],
        [286.644, 262.816, 297.584],
      ),
    ).toBeNull();
    // Same control, arms interleaved: +30.9ms apparent effect.
    expect(
      computeCallbackIdentityDelta(
        [287.139, 306.397, 306.358],
        [320.928, 337.233, 353.238],
      ),
    ).toBeNull();
  });

  it("rejects a delta under the absolute floor", () => {
    expect(computeCallbackIdentityDelta([10, 10, 10], [10.3, 10.3, 10.3])).toBeNull();
  });

  it("rejects a negative or zero delta", () => {
    expect(computeCallbackIdentityDelta([50, 51, 52], [40, 41, 42])).toBeNull();
    expect(computeCallbackIdentityDelta([50, 50, 50], [50, 50, 50])).toBeNull();
  });

  it("reports nothing when an arm cannot estimate its own noise", () => {
    expect(computeCallbackIdentityDelta([10], [300])).toBeNull();
    expect(computeCallbackIdentityDelta([], [])).toBeNull();
    expect(computeCallbackIdentityDelta([10, 10], [300])).toBeNull();
  });
});
