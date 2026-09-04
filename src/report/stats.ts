import type { ScalingCurve } from "../analysis/index.js";

// One predicate, so the growth column, the JSON and the hint can never disagree
// about what "superlinear" means.
export function isSuperlinearGrowth(curve: ScalingCurve | null | undefined): boolean {
  return curve?.growthClass === "quadratic" || curve?.growthClass === "exponential";
}
