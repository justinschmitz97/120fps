import { describe, it, expect } from "vitest";
import type { PropSchema, ScalingPropMatch } from "../../src/prop-gen.js";
import {
  generateCombinations,
  generateDeltaPairs,
  generateScalingCombos,
  generatePropMatrix,
} from "../../src/prop-gen-values.js";
import { applyPropPresets, type PropPresets } from "../../src/prop-presets.js";

// M81 section 4: --explain-props and the run consume the same
// `schema.degenerate` flag. This is exercised at the four combo generators
// the run actually calls, so a degenerate prop never reaches the browser as
// a fabricated `{}`/placeholder in ANY generation path, matching what
// --explain-props already prints for the same schema.
const degenerateObject: PropSchema = {
  name: "config",
  kind: "object",
  required: false,
  values: [{}],
  degenerate: "no synthesizable members on Config",
};

const degenerateReactNode: PropSchema = {
  name: "render",
  kind: "reactnode",
  required: false,
  values: [],
  degenerate: "SomeType requires a real element or render function",
};

const boolSchema: PropSchema = { name: "flag", kind: "boolean", required: true, values: [true, false] };
const numericSchema: PropSchema = { name: "count", kind: "number", required: true, values: [1, 5, 20] };

describe("M81 section 4: degenerate props never carry a fabricated value through generation", () => {
  it("generateCombinations: a degenerate object prop is always undefined", () => {
    const combos = generateCombinations([boolSchema, degenerateObject]);
    expect(combos.length).toBeGreaterThan(0);
    for (const combo of combos) expect(combo.config).toBeUndefined();
  });

  it("generateCombinations: a degenerate reactnode prop is always undefined", () => {
    const combos = generateCombinations([boolSchema, degenerateReactNode]);
    for (const combo of combos) expect(combo.render).toBeUndefined();
  });

  it("generateDeltaPairs: the shared anchor never carries a fabricated degenerate value", () => {
    const pairs = generateDeltaPairs([boolSchema, degenerateObject]);
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(pair.baseCombo.config).toBeUndefined();
      expect(pair.flipCombo.config).toBeUndefined();
    }
  });

  it("generateScalingCombos: the shared anchor never carries a fabricated degenerate value", () => {
    const match: ScalingPropMatch = { schema: numericSchema, kind: "numeric", reason: "numeric prop" };
    const combos = generateScalingCombos([numericSchema, degenerateObject], match, [1, 5, 20]);
    expect(combos.length).toBe(3);
    for (const combo of combos) expect(combo.config).toBeUndefined();
  });

  it("generatePropMatrix: the anchor for non-matrix-eligible props never carries a fabricated degenerate value", () => {
    const cells = generatePropMatrix([boolSchema, degenerateObject]);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.config).toBeUndefined();
  });

  it("a preset override supplies the real value and clears degenerate, matching --explain-props", () => {
    const presets: PropPresets = {
      path: "config.props.tsx",
      absolutePath: "/abs/config.props.tsx",
      entries: new Map([["config", [{ real: true }]]]),
    };
    const { schemas } = applyPropPresets([degenerateObject], presets);
    expect(schemas[0].degenerate).toBeUndefined();

    const combos = generateCombinations([boolSchema, schemas[0]]);
    expect(combos.some((c) => JSON.stringify(c.config) === JSON.stringify({ real: true }))).toBe(true);
  });
});
