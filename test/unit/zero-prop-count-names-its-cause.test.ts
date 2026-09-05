import { describe, it, expect } from "vitest";
import { explainsZeroPropCount, ZERO_PROPS_WARNING } from "../../src/pipeline/index.js";
import {
  UNTYPED_JS_COMPONENT_WARNING,
  VUE_UNRESOLVED_PROPS_TYPE_WARNING,
  VUE_OPTIONS_API_PROPS_WARNING,
} from "../../src/props/index.js";

// element-plus-F3: ZERO_PROPS_WARNING stacked on an already-named cause is false; M97/M98 add more.

describe("the generic zero-prop hedge yields to a stated cause", () => {
  it("recognizes a Vue scope exclusion", () => {
    expect(explainsZeroPropCount(VUE_OPTIONS_API_PROPS_WARNING("/p/Badge.vue"))).toBe(true);
  });

  it("recognizes an unresolved defineProps type argument", () => {
    expect(explainsZeroPropCount(VUE_UNRESOLVED_PROPS_TYPE_WARNING("/p/Badge.vue", "BadgeProps"))).toBe(true);
  });

  it("recognizes a JavaScript component with no declaration beside it", () => {
    expect(explainsZeroPropCount(UNTYPED_JS_COMPONENT_WARNING("/p/Badge.js", "Badge"))).toBe(true);
  });

  it("does not claim to explain an unrelated warning", () => {
    expect(explainsZeroPropCount(ZERO_PROPS_WARNING)).toBe(false);
    expect(explainsZeroPropCount("Stylesheets: none found")).toBe(false);
  });
});
