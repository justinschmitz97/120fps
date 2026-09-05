import type { PropCombination } from "./values.js";

export const FUNCTION_MARKER = "__120fps_fn__";

export function serializeProps(props: PropCombination): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") {
      result[key] = FUNCTION_MARKER;
    } else {
      result[key] = value;
    }
  }
  return result;
}
