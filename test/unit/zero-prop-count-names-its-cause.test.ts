import { describe, it, expect } from "vitest";
import { explainsZeroPropCount, ZERO_PROPS_WARNING } from "../../src/analyze.js";
import {
  UNTYPED_JS_COMPONENT_WARNING,
  VUE_UNRESOLVED_PROPS_TYPE_WARNING,
  VUE_OPTIONS_API_PROPS_WARNING,
} from "../../src/prop-gen.js";

// ZERO_PROPS_WARNING floats a possible malfunction ("extraction may have
// failed"). Whenever the same run already named the cause of the zero count,
// that phrase is false: element-plus-F3 found the pair stacked for a Vue scope
// exclusion, and M97/M98 add two more causes with the same register.

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
