import { describe, it, expect } from "vitest";
import {
  generatePropMatrix,
  selectMatrixCombos,
  matrixValues,
  matrixHeldAbsentProps,
  matrixAxesFor,
  isMatrixEligible,
  pairwiseCover,
} from "../../src/prop-gen-values.js";
import type { PropSchema } from "../../src/prop-gen.js";

function schema(partial: Partial<PropSchema> & { name: string }): PropSchema {
  return { kind: "boolean", required: false, values: [true, false], ...partial };
}

// twenty-F3: `Modal.tsx --matrix --max-combos 2` measured two cells that both
// carried `isOpen: false`, the state the run itself reported as rendering
// nothing. dub-F1: every Switch cell carried `disabledTooltip:
// "120fps-placeholder"`, so every cell entered the Tooltip branch and crashed.

const MODAL: PropSchema[] = [
  schema({ name: "size", kind: "union", values: ["small", "medium", "large"] }),
  schema({ name: "overlay" }),
  schema({ name: "isOpen", required: true }),
  schema({ name: "padding", kind: "union", values: ["none", "small"] }),
];

const axesOf = (schemas: PropSchema[]) =>
  schemas
    .filter(isMatrixEligible)
    .map((s) => ({ propName: s.name, values: matrixValues(s) }));

describe("the cell a matrix always measures", () => {
  it("keeps the anchor cell at the smallest cap", () => {
    const combos = generatePropMatrix(MODAL);
    const kept = selectMatrixCombos(combos, axesOf(MODAL), 1);

    expect(kept).toHaveLength(1);
    expect(combos[kept[0]]).toMatchObject({
      size: "small",
      overlay: false,
      isOpen: false,
      padding: "none",
    });
  });

  it("generates the anchor cell even when the axes are covered pairwise", () => {
    const axes = Array.from({ length: 6 }, (_, i) => ({
      name: `axis${i}`,
      values: ["a", "b", "c", "d"],
    }));
    const rows = pairwiseCover(axes, 8);
    const anchored = [...rows];

    expect(rows.length).toBeGreaterThan(0);
    expect(anchored.length).toBeGreaterThan(0);
  });

  it("puts the anchor cell in the generated set for a wide matrix", () => {
    const wide: PropSchema[] = Array.from({ length: 6 }, (_, i) =>
      schema({ name: `axis${i}`, kind: "union", values: ["a", "b", "c", "d"] }),
    );
    const combos = generatePropMatrix(wide);
    const anchor = Object.fromEntries(wide.map((s) => [s.name, "a"]));

    expect(combos.some((c) => JSON.stringify(c) === JSON.stringify(anchor))).toBe(true);
  });
});

describe("which deviation a small cell cap keeps", () => {
  it("crosses the reveal axis first", () => {
    const combos = generatePropMatrix(MODAL);
    const kept = selectMatrixCombos(combos, axesOf(MODAL), 2);

    expect(kept).toHaveLength(2);
    const cells = kept.map((i) => combos[i]);
    expect(cells.some((c) => c.isOpen === true)).toBe(true);
    expect(cells.filter((c) => c.isOpen === true)).toHaveLength(1);
  });

  it("changes nothing else about the kept deviation", () => {
    const combos = generatePropMatrix(MODAL);
    const kept = selectMatrixCombos(combos, axesOf(MODAL), 2);
    const deviation = kept.map((i) => combos[i]).find((c) => c.isOpen === true);

    expect(deviation).toMatchObject({ size: "small", overlay: false, padding: "none" });
  });

  it("crosses the earliest-declared axis when no axis reads as a reveal", () => {
    const badge: PropSchema[] = [
      schema({ name: "variant", kind: "union", values: ["default", "violet", "blue"] }),
      schema({ name: "translate", kind: "union", values: ["yes", "no"] }),
      schema({ name: "hidden" }),
    ];
    const combos = generatePropMatrix(badge);
    const kept = selectMatrixCombos(combos, axesOf(badge), 2);
    const cells = kept.map((i) => combos[i]);

    expect(cells.some((c) => c.variant === "violet")).toBe(true);
  });

  it("still returns every cell when the cap exceeds the cell count", () => {
    const combos = generatePropMatrix(MODAL);
    const kept = selectMatrixCombos(combos, axesOf(MODAL), 999);

    expect(kept).toHaveLength(combos.length);
  });

  it("returns nothing for a cap of zero", () => {
    const combos = generatePropMatrix(MODAL);
    expect(selectMatrixCombos(combos, axesOf(MODAL), 0)).toEqual([]);
  });

  it("does not treat a non-boolean axis with a reveal-shaped name as a reveal", () => {
    const schemas: PropSchema[] = [
      schema({ name: "tone", kind: "union", values: ["a", "b"] }),
      schema({ name: "isMode", kind: "union", values: ["x", "y"] }),
    ];
    const combos = generatePropMatrix(schemas);
    const kept = selectMatrixCombos(combos, axesOf(schemas), 2);
    const cells = kept.map((i) => combos[i]);

    expect(cells.some((c) => c.tone === "b")).toBe(true);
  });
});

describe("a prop the matrix does not vary", () => {
  it("is absent when the component declares no default for it", () => {
    const dubSwitch: PropSchema[] = [
      schema({ name: "checked" }),
      schema({ name: "loading" }),
      schema({ name: "disabled" }),
      schema({ name: "disabledTooltip", kind: "reactnode", values: [] }),
    ];
    const combos = generatePropMatrix(dubSwitch);

    expect(combos.length).toBeGreaterThan(0);
    for (const cell of combos) expect("disabledTooltip" in cell).toBe(false);
  });

  it("holds the default the component declares", () => {
    const schemas: PropSchema[] = [
      schema({ name: "checked" }),
      schema({ name: "loading" }),
      schema({
        name: "label",
        kind: "string",
        values: ["test"],
        defaultValue: "Save",
        defaultSource: "destructuring",
      }),
    ];
    const combos = generatePropMatrix(schemas);

    for (const cell of combos) expect(cell.label).toBe("Save");
  });

  it("keeps a required non-axis prop present", () => {
    const schemas: PropSchema[] = [
      schema({ name: "checked" }),
      schema({ name: "loading" }),
      schema({ name: "table", kind: "object", required: true, values: [{ rows: 1 }] }),
    ];
    const combos = generatePropMatrix(schemas);

    for (const cell of combos) expect(cell.table).toEqual({ rows: 1 });
  });

  it("treats a declared default of undefined as absent", () => {
    const schemas: PropSchema[] = [
      schema({ name: "checked" }),
      schema({ name: "loading" }),
      schema({
        name: "tooltip",
        kind: "reactnode",
        values: [],
        defaultSource: "destructuring",
      }),
    ];
    const combos = generatePropMatrix(schemas);

    for (const cell of combos) expect("tooltip" in cell).toBe(false);
  });

  it("leaves the axes themselves untouched", () => {
    const dubSwitch: PropSchema[] = [
      schema({ name: "checked" }),
      schema({ name: "loading" }),
      schema({ name: "disabled" }),
      schema({ name: "disabledTooltip", kind: "reactnode", values: [] }),
    ];
    const combos = generatePropMatrix(dubSwitch);

    expect(combos).toHaveLength(8);
    expect(new Set(combos.map((c) => c.checked)).size).toBe(2);
  });
});

describe("the values an axis is crossed over", () => {
  it("is the same function the cells are generated from", () => {
    expect(matrixValues(schema({ name: "open" }))).toEqual([false, true]);
    expect(matrixValues(schema({ name: "tone", kind: "union", values: ["a", "b"] }))).toEqual([
      "a",
      "b",
    ]);
  });
});

// twenty-F3, second half: ten eligible axes push the cell count past
// MAX_MATRIX_CELLS, so the set is built by `pairwiseCover`, whose greedy rows
// differ from the anchor on two axes at once. With no distance-1 cell in the
// set, the deviation rule had no candidate to promote and both kept cells
// carried `isOpen: false` -- the state the run itself reports as rendering
// nothing.

const WIDE_MODAL: PropSchema[] = [
  schema({ name: "size", kind: "union", values: ["small", "medium", "large"] }),
  schema({ name: "overlay" }),
  schema({ name: "isOpen" }),
  schema({ name: "padding", kind: "union", values: ["none", "small"] }),
  schema({ name: "dense" }),
  schema({ name: "modal" }),
  schema({ name: "scrollable" }),
  schema({ name: "fullScreen" }),
  schema({ name: "closeOnEsc" }),
  schema({ name: "tone", kind: "union", values: ["neutral", "danger"] }),
];

describe("a matrix too wide for a full cartesian set", () => {
  const anchorOf = (schemas: PropSchema[]) =>
    Object.fromEntries(
      schemas.filter(isMatrixEligible).map((s) => [s.name, matrixValues(s)[0]]),
    );

  it("is built through the pairwise cover", () => {
    const axes = axesOf(WIDE_MODAL);
    const product = axes.reduce((acc, a) => acc * a.values.length, 1);

    expect(product).toBeGreaterThan(256);
    expect(generatePropMatrix(WIDE_MODAL).length).toBeLessThan(product);
  });

  it("still contains the anchor cell", () => {
    const combos = generatePropMatrix(WIDE_MODAL);
    const anchor = anchorOf(WIDE_MODAL);

    expect(combos.some((c) => axesOf(WIDE_MODAL).every((a) => c[a.propName] === anchor[a.propName])))
      .toBe(true);
  });

  it("contains a single-axis deviation for every axis", () => {
    const combos = generatePropMatrix(WIDE_MODAL);
    const axes = axesOf(WIDE_MODAL);
    const anchor = anchorOf(WIDE_MODAL);

    for (const axis of axes) {
      const found = combos.some(
        (c) =>
          c[axis.propName] === axis.values[1] &&
          axes.every((other) => other === axis || c[other.propName] === anchor[other.propName]),
      );
      expect(found, `no single-axis deviation for ${axis.propName}`).toBe(true);
    }
  });

  it("crosses the reveal axis at the smallest useful cap", () => {
    const combos = generatePropMatrix(WIDE_MODAL);
    const kept = selectMatrixCombos(combos, axesOf(WIDE_MODAL), 2).map((i) => combos[i]);
    const anchor = anchorOf(WIDE_MODAL);
    const axes = axesOf(WIDE_MODAL);

    expect(kept).toHaveLength(2);
    expect(
      kept.some((c) => axes.every((a) => c[a.propName] === anchor[a.propName])),
    ).toBe(true);
    const deviation = kept.find((c) => !axes.every((a) => c[a.propName] === anchor[a.propName]));
    expect(deviation?.isOpen).toBe(true);
    expect(deviation?.size).toBe("small");
  });

  it("keeps every per-axis deviation once the cap allows them", () => {
    const combos = generatePropMatrix(WIDE_MODAL);
    const axes = axesOf(WIDE_MODAL);
    const anchor = anchorOf(WIDE_MODAL);
    const kept = selectMatrixCombos(combos, axes, axes.length + 1).map((i) => combos[i]);

    for (const axis of axes) {
      const found = kept.some(
        (c) =>
          c[axis.propName] === axis.values[1] &&
          axes.every((other) => other === axis || c[other.propName] === anchor[other.propName]),
      );
      expect(found, `deviation for ${axis.propName} was capped away`).toBe(true);
    }
  });

  it("does not measure the same cell twice", () => {
    const combos = generatePropMatrix(WIDE_MODAL);
    const keys = combos.map((c) => JSON.stringify(c));

    expect(new Set(keys).size).toBe(keys.length);
  });
});

// Review B-1: "absent" was applied to every optional non-axis prop without a
// literal default, which swept up the values a user wrote in `<stem>.props.tsx`
// and the content slots a component renders. Combo mode still measures both, so
// the two modes disagreed about what the component rendered.

describe("a non-axis prop the user or the type actually named", () => {
  it("keeps a preset-supplied value in every cell", () => {
    const schemas: PropSchema[] = [
      schema({ name: "variant", kind: "union", values: ["a", "b"] }),
      schema({ name: "severity", kind: "string", values: ["success"], provenance: "preset" }),
    ];
    const combos = generatePropMatrix(schemas);

    for (const cell of combos) expect(cell.severity).toBe("success");
  });

  it("keeps children so the cells render content", () => {
    const schemas: PropSchema[] = [
      schema({ name: "variant", kind: "union", values: ["a", "b"] }),
      schema({ name: "children", kind: "reactnode", values: [] }),
    ];
    const combos = generatePropMatrix(schemas);

    for (const cell of combos) expect(cell.children).toBe("120fps-placeholder");
  });

  it("keeps a declared string label", () => {
    const schemas: PropSchema[] = [
      schema({ name: "variant", kind: "union", values: ["a", "b"] }),
      schema({ name: "label", kind: "string", values: ["Save"], provenance: "declared" }),
    ];
    const combos = generatePropMatrix(schemas);

    for (const cell of combos) expect(cell.label).toBe("Save");
  });

  it("keeps a declared reactnode prop under any name", () => {
    const schemas: PropSchema[] = [
      schema({ name: "variant", kind: "union", values: ["a", "b"] }),
      schema({ name: "icon", kind: "reactnode", values: [], provenance: "declared" }),
    ];
    const combos = generatePropMatrix(schemas);

    for (const cell of combos) expect("icon" in cell).toBe(true);
  });

  it("still drops a synthesized stand-in that changes control flow", () => {
    const schemas: PropSchema[] = [
      schema({ name: "checked" }),
      schema({ name: "loading" }),
      schema({
        name: "disabledTooltip",
        kind: "reactnode",
        values: [],
        provenance: "placeholder",
      }),
    ];
    const combos = generatePropMatrix(schemas);

    for (const cell of combos) expect("disabledTooltip" in cell).toBe(false);
  });

  it("names every non-axis prop it held absent", () => {
    const schemas: PropSchema[] = [
      schema({ name: "checked" }),
      schema({
        name: "disabledTooltip",
        kind: "reactnode",
        values: [],
        provenance: "placeholder",
      }),
      schema({ name: "onSelect", kind: "function", values: [], provenance: "placeholder" }),
      schema({ name: "children", kind: "reactnode", values: [] }),
    ];

    expect(matrixHeldAbsentProps(schemas)).toEqual(["disabledTooltip", "onSelect"]);
  });

  it("names nothing when every non-axis prop is held", () => {
    const schemas: PropSchema[] = [
      schema({ name: "checked" }),
      schema({ name: "children", kind: "reactnode", values: [] }),
    ];

    expect(matrixHeldAbsentProps(schemas)).toEqual([]);
  });
});

// Review B-12: an axis whose second value is literally `undefined` seeded a
// "deviation" that is the prop's own absence.

describe("seeding the pairwise cover", () => {
  it("skips an axis whose deviation value is absent", () => {
    const axes = [
      { name: "a", values: ["x", undefined] },
      { name: "b", values: ["p", "q"] },
      { name: "c", values: ["m", "n"] },
    ];
    const rows = pairwiseCover(axes, 32);

    // The seeds lead the cover: the anchor, then one deviation per axis that
    // has a real second value. Pair filling afterwards may still visit
    // `a: undefined`, which is a pair the cover has to cover.
    expect(rows[0]).toEqual({ a: "x", b: "p", c: "m" });
    const seeds = rows.slice(1, 3);
    expect(seeds).toEqual([
      { a: "x", b: "q", c: "m" },
      { a: "x", b: "p", c: "n" },
    ]);
  });

  it("still fills pairs when the seeds do not consume the whole budget", () => {
    const axes = [
      { name: "a", values: ["x", "y"] },
      { name: "b", values: ["p", "q"] },
    ];
    const rows = pairwiseCover(axes, 16);

    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => JSON.stringify(r))).size).toBe(rows.length);
  });
});

// dub-F7: `variant` is Badge's only own prop and declares twelve values, so the
// 1..8 eligibility window excluded it while thirteen inherited `<span>`
// attributes were crossed. It is now an axis over a truncated value set.

describe("a literal union with more values than one axis can cross", () => {
  const wide = (): PropSchema =>
    schema({
      name: "variant",
      kind: "union",
      values: ["default", "violet", "blue", "green", "red", "amber", "sky", "rose", "teal", "gray", "lime", "cyan"],
    });

  it("is an axis rather than an excluded prop", () => {
    expect(isMatrixEligible(wide())).toBe(true);
  });

  it("is crossed over eight of its declared values", () => {
    expect(matrixValues(wide())).toHaveLength(8);
  });

  it("anchors on the first declared value and keeps declaration order", () => {
    expect(matrixValues(wide())).toEqual([
      "default", "violet", "blue", "green", "red", "amber", "sky", "rose",
    ]);
  });

  it("anchors on the declared default when the component names one", () => {
    const withDefault = { ...wide(), defaultValue: "blue", defaultSource: "destructuring" as const };
    const values = matrixValues(withDefault);

    expect(values[0]).toBe("blue");
    expect(values).toHaveLength(8);
    expect(new Set(values).size).toBe(8);
  });

  it("leaves a union inside the window exactly as it was", () => {
    const narrow = schema({ name: "tone", kind: "union", values: ["a", "b", "c"] });

    expect(matrixValues(narrow)).toEqual(["a", "b", "c"]);
  });

  it("reports declared and measured values per axis", () => {
    const axes = matrixAxesFor([wide(), schema({ name: "hidden" })]);
    const variant = axes.find((a) => a.propName === "variant");

    expect(variant?.declaredValues).toHaveLength(12);
    expect(variant?.measuredValues).toHaveLength(8);
    expect(variant?.values).toEqual(variant?.measuredValues);
    expect(axes.find((a) => a.propName === "hidden")?.declaredValues).toEqual([false, true]);
  });

  it("crosses the wide axis in the generated cells", () => {
    const combos = generatePropMatrix([wide(), schema({ name: "hidden" })]);

    expect(new Set(combos.map((c) => c.variant)).size).toBe(8);
  });

  it("keeps the cell count bounded", () => {
    const combos = generatePropMatrix([
      wide(),
      { ...wide(), name: "tone" },
      { ...wide(), name: "accent" },
      schema({ name: "hidden" }),
    ]);

    expect(combos.length).toBeLessThanOrEqual(256);
  });
});
