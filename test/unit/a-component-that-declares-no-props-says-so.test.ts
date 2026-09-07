import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  explainProps,
  explainsZeroPropCount,
  zeroPropCountWarning,
  ZERO_PROPS_WARNING,
} from "../../src/pipeline/index.js";
import { UNRESOLVED_ANNOTATION_MODULE_WARNING } from "../../src/props/index.js";

const fixture = (rel: string): string => path.resolve("fixtures", rel);
const VUE_ROOT = path.resolve("fixtures/vue-project");

const HEDGE = "extraction may have failed";

describe("the zero-prop line for a component that declares none", () => {
  it("states that the component declares no props", () => {
    expect(ZERO_PROPS_WARNING).toContain("No props extracted");
    expect(ZERO_PROPS_WARNING).toContain("declares no props");
  });

  it("states that extraction did not fail, as the Vue runtime-props line does", () => {
    expect(ZERO_PROPS_WARNING).toContain("extraction did not fail");
    expect(ZERO_PROPS_WARNING).not.toContain(HEDGE);
  });

  it("is what a run with nothing to suspect produces", () => {
    expect(zeroPropCountWarning([])).toBe(ZERO_PROPS_WARNING);
    expect(zeroPropCountWarning(["Stylesheets: none found"])).toBe(ZERO_PROPS_WARNING);
  });

  it("explains the zero count, so the generic remedy is not stacked on it", () => {
    expect(explainsZeroPropCount(ZERO_PROPS_WARNING)).toBe(true);
  });
});

describe("the zero-prop line when the run has a reason to suspect extraction", () => {
  const unresolved = UNRESOLVED_ANNOTATION_MODULE_WARNING(
    "/p/Ghost.tsx",
    "Ghost",
    "GhostProps",
    ["./ghost-types"],
  );

  it("keeps the hedge and names the reason in the same line", () => {
    const warning = zeroPropCountWarning([unresolved]);
    expect(warning).toContain(HEDGE);
    expect(warning).toContain("resolves to no file on disk");
  });

  it("does not claim to explain the zero count, so the hedge stays visible", () => {
    expect(explainsZeroPropCount(zeroPropCountWarning([unresolved]))).toBe(false);
  });

  it("names an annotation the extractor could not enumerate", () => {
    const unenumerable =
      "props type Props<T> for Widget in /p/Widget.tsx could not be enumerated: measuring with no props.";
    const warning = zeroPropCountWarning([unenumerable]);
    expect(warning).toContain(HEDGE);
    expect(warning).toContain("could not be enumerated");
  });
});

describe("the dry run's zero-prop line over real sources", () => {
  it("says a parameterless arrow component declares none", async () => {
    const explained = await explainProps(fixture("no-props-declared/arrow.tsx"));
    expect(explained.props).toEqual([]);
    expect(explained.warnings).toContain(ZERO_PROPS_WARNING);
    expect(explained.warnings.some((w) => w.includes(HEDGE))).toBe(false);
  });

  it("says a memoized parameterless component declares none", async () => {
    const explained = await explainProps(fixture("no-props-declared/memo.tsx"));
    expect(explained.props).toEqual([]);
    expect(explained.warnings).toContain(ZERO_PROPS_WARNING);
    expect(explained.warnings.some((w) => w.includes(HEDGE))).toBe(false);
  });

  it("says a Vue SFC with no props declaration declares none", async () => {
    const explained = await explainProps(path.join(VUE_ROOT, "NoProps.vue"));
    expect(explained.props).toEqual([]);
    expect(explained.warnings).toContain(ZERO_PROPS_WARNING);
    expect(explained.warnings.some((w) => w.includes(HEDGE))).toBe(false);
  });

  it("hedges and names the module when the props type resolves to no file", async () => {
    const explained = await explainProps(fixture("no-props-declared/unresolved-annotation.tsx"));
    expect(explained.props).toEqual([]);
    expect(explained.warnings).not.toContain(ZERO_PROPS_WARNING);
    const hedged = explained.warnings.find((w) => w.includes(HEDGE));
    expect(hedged).toBeDefined();
    expect(hedged).toContain("resolves to no file on disk");
  });
});
