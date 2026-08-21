import type { PropSchema, ScalingPropMatch } from "./prop-gen.js";

export type PropCombination = Record<string, unknown>;

export interface DeltaPair {
  propName: string;
  baseCombo: PropCombination;
  flipCombo: PropCombination;
  baseValue: unknown;
  flipValue: unknown;
}

export const MAX_DELTA_PAIRS = 128;

function buildAllDeltaPairs(schemas: PropSchema[]): DeltaPair[] {
  if (schemas.length === 0) return [];

  const anchor: PropCombination = {};
  for (const s of schemas) {
    anchor[s.name] = resolveAnchorValue(s);
  }

  const boolPairs: DeltaPair[] = [];
  const unionPairs: DeltaPair[] = [];
  const objectPairs: DeltaPair[] = [];

  for (const s of schemas) {
    if (s.kind === "boolean") {
      boolPairs.push({
        propName: s.name,
        baseCombo: { ...anchor, [s.name]: false },
        flipCombo: { ...anchor, [s.name]: true },
        baseValue: false,
        flipValue: true,
      });
    } else if (s.kind === "union" && s.values.length > 1) {
      const base = s.values[0];
      for (let i = 1; i < s.values.length; i++) {
        unionPairs.push({
          propName: s.name,
          baseCombo: { ...anchor, [s.name]: base },
          flipCombo: { ...anchor, [s.name]: s.values[i] },
          baseValue: base,
          flipValue: s.values[i],
        });
      }
    } else if (s.kind === "object" && !s.required && !s.degenerate) {
      // M81 3c/4: a degenerate schema has no real value to flip to (base and
      // flip would be the same fabricated stand-in), so it does not
      // participate in its own delta pair; it still flows into `anchor` via
      // `resolveAnchorValue`, which resolves it to `undefined` for every
      // other prop's pair.
      const firstVal = s.values.length > 0 ? s.values[0] : {};
      objectPairs.push({
        propName: s.name,
        baseCombo: { ...anchor, [s.name]: undefined },
        flipCombo: { ...anchor, [s.name]: firstVal },
        baseValue: undefined,
        flipValue: firstVal,
      });
    }
  }

  unionPairs.sort((a, b) => {
    const aCount = schemas.find((s) => s.name === a.propName)!.values.length;
    const bCount = schemas.find((s) => s.name === b.propName)!.values.length;
    return aCount - bCount;
  });

  return [...boolPairs, ...unionPairs, ...objectPairs];
}

export function generateDeltaPairs(schemas: PropSchema[]): DeltaPair[] {
  return buildAllDeltaPairs(schemas).slice(0, MAX_DELTA_PAIRS);
}

// Total delta pairs the prop space could produce before the MAX_DELTA_PAIRS
// cap truncates them: lets a caller detect and disclose truncation without
// re-deriving the counting logic.
export function countDeltaPairSpace(schemas: PropSchema[]): number {
  return buildAllDeltaPairs(schemas).length;
}

export function generateScalingCombos(
  schemas: PropSchema[],
  match: ScalingPropMatch,
  scalePoints: number[],
): PropCombination[] {
  const anchor: PropCombination = {};
  for (const s of schemas) {
    anchor[s.name] = resolveAnchorValue(s);
  }

  return scalePoints.map((n) => {
    const combo = { ...anchor };
    if (match.kind === "numeric") {
      combo[match.schema.name] = n;
    } else {
      combo[match.schema.name] = fillArray(match.schema, n);
    }
    return combo;
  });
}

// Each element gets its own identity so a component keying or mutating them
// behaves as it would with real data.
export function fillArray(schema: PropSchema, n: number): unknown[] {
  const template = schema.elementTemplate;
  if (template === undefined) {
    return Array.from({ length: n }, (_, i) => `item-${i + 1}`);
  }
  return Array.from({ length: n }, () => cloneTemplate(template));
}

function cloneTemplate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneTemplate);
  // Instants and patterns are values, not field bags: walking their entries
  // would hand the component `{}` where the element type says `Date`.
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneTemplate(v);
    }
    return out;
  }
  return value;
}

// M81 3c/4: a degenerate "object"/"reactnode" schema has no faithful value to
// synthesize; the run and `--explain-props` must agree it is unusable, so
// this returns an omitted prop, not a fabricated stand-in. A preset override
// clears `degenerate` (`applyPropPresets`), so this never overrides one.
function isUnsafeDegenerate(schema: PropSchema): boolean {
  return !!schema.degenerate && (schema.kind === "object" || schema.kind === "reactnode");
}

export function resolveAnchorValue(schema: PropSchema): unknown {
  if (isUnsafeDegenerate(schema)) return undefined;
  switch (schema.kind) {
    case "boolean":
      return false;
    case "string":
      return schema.values.length > 0 ? schema.values[0] : "test";
    case "number":
      return schema.values.length > 0 ? schema.values[0] : 1;
    case "union":
      return schema.values[0];
    case "array":
      return [];
    case "function":
      return () => {};
    case "reactnode":
      return "120fps-placeholder";
    case "object":
      return schema.values.length > 0 ? schema.values[0] : {};
    case "unknown":
      return undefined;
  }
}

const MAX_COMBINATIONS = 64;

const NOOP = () => {};

const REACT_PLACEHOLDER = "120fps-placeholder";

// Identity for measurement purposes: two combos with this key would time the
// same render twice and be reported as distinct rows. Covers the values the
// pipeline can carry: JSON data plus Date/RegExp: and never conflates a key
// that is present-but-undefined with one that is absent.
export function comboKey(value: unknown): string {
  if (value === undefined) return "~undef";
  if (value === null) return "~null";
  if (typeof value === "function") return `~fn:${value.name}`;
  if (value instanceof Date) return `~date:${value.getTime()}`;
  if (value instanceof RegExp) return `~re:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(comboKey).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${comboKey(record[k])}`)
      .join(",")}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function dedupeCombos(combos: PropCombination[]): PropCombination[] {
  const seen = new Set<string>();
  const unique: PropCombination[] = [];
  for (const combo of combos) {
    const key = comboKey(combo);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(combo);
  }
  return unique;
}

export function generateCombinations(schemas: PropSchema[]): PropCombination[] {
  const valuesByProp = schemas.map((s) => resolveValues(s));

  const total = valuesByProp.reduce((acc, v) => acc * v.length, 1);

  // Belt and braces: the pools are already de-duplicated, so this only catches
  // a future source of duplicates: cheaply, and before any cap is applied.
  if (total <= MAX_COMBINATIONS) {
    return dedupeCombos(cartesian(schemas, valuesByProp));
  }

  return dedupeCombos(stratifiedSample(schemas, valuesByProp, MAX_COMBINATIONS));
}

// Size of the full cartesian prop space before MAX_COMBINATIONS forces a
// stratified sample: lets a caller detect and disclose the truncation. Can
// be astronomically large (many multi-valued props); callers must cap how
// they display it rather than trust arithmetic precision at that scale.
export function countCombinationSpace(schemas: PropSchema[]): number {
  const valuesByProp = schemas.map((s) => resolveValues(s));
  return valuesByProp.reduce((acc, v) => acc * v.length, 1);
}

// An optional prop is worth measuring absent, but only once: a pool that is
// already `[undefined]`: an unknown type, or a preset that says so: must not
// gain a second one and cartesian-double every combination.
function resolveValues(schema: PropSchema): unknown[] {
  const base = resolveBaseValues(schema);
  const pool = schema.required ? base : [...base, undefined];

  const seen = new Set<string>();
  return pool.filter((value) => {
    const key = comboKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveBaseValues(schema: PropSchema): unknown[] {
  if (isUnsafeDegenerate(schema)) return [undefined];
  switch (schema.kind) {
    case "boolean":
      return [true, false];
    case "string":
      return schema.values.length > 0 ? schema.values : ["test"];
    case "number":
      return schema.values.length > 0 ? schema.values : [1, 5, 20];
    case "union":
      return schema.values;
    case "array":
      return [[], fillArray(schema, 3)];
    case "function":
      return [NOOP];
    case "reactnode":
      return [REACT_PLACEHOLDER];
    case "object":
      return schema.values.length > 0 ? schema.values : [{}];
    case "unknown":
      return [undefined];
  }
}

function cartesian(
  schemas: PropSchema[],
  valuesByProp: unknown[][],
): PropCombination[] {
  const results: PropCombination[] = [];
  const indices = new Array(schemas.length).fill(0) as number[];

  while (true) {
    const combo: PropCombination = {};
    for (let i = 0; i < schemas.length; i++) {
      combo[schemas[i].name] = valuesByProp[i][indices[i]];
    }
    results.push(combo);

    let carry = schemas.length - 1;
    while (carry >= 0) {
      indices[carry]++;
      if (indices[carry] < valuesByProp[carry].length) break;
      indices[carry] = 0;
      carry--;
    }
    if (carry < 0) break;
  }

  return results;
}

function stratifiedSample(
  schemas: PropSchema[],
  valuesByProp: unknown[][],
  max: number,
): PropCombination[] {
  // Ensure every value of every prop appears at least once
  const results: PropCombination[] = [];
  const seen = new Set<string>();

  // Phase 1: cover every value of every prop
  const maxValues = Math.max(...valuesByProp.map((v) => v.length));
  for (let row = 0; row < maxValues && results.length < max; row++) {
    const combo: PropCombination = {};
    for (let i = 0; i < schemas.length; i++) {
      combo[schemas[i].name] =
        valuesByProp[i][row % valuesByProp[i].length];
    }
    const key = JSON.stringify(combo);
    if (!seen.has(key)) {
      seen.add(key);
      results.push(combo);
    }
  }

  // Phase 2: fill remaining budget with deterministic pseudo-random combos
  let seed = 42;
  const nextRand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };

  let attempts = 0;
  while (results.length < max && attempts < max * 10) {
    attempts++;
    const combo: PropCombination = {};
    for (let i = 0; i < schemas.length; i++) {
      const idx = nextRand() % valuesByProp[i].length;
      combo[schemas[i].name] = valuesByProp[i][idx];
    }
    const key = JSON.stringify(combo);
    if (!seen.has(key)) {
      seen.add(key);
      results.push(combo);
    }
  }

  return results;
}

const MAX_MATRIX_CELLS = 256;
const MAX_MATRIX_AUTO_CELLS = 64;

export function isMatrixEligible(schema: PropSchema): boolean {
  if (schema.kind === "boolean") return true;
  // M104 / I10 (dub-F7): a literal union is an axis whatever its arity. dub's
  // Badge declares `variant` with twelve values, and a 1..8 window excluded the
  // component's only own prop while thirteen inherited `<span>` attributes were
  // crossed. An over-wide union is crossed over a truncated value set instead
  // (`matrixValues`), so the cell-count bound is unchanged.
  if (schema.kind === "union" && schema.values.length >= 1) return true;
  return false;
}

// The most values one axis is ever crossed over. Beyond this the axis keeps its
// anchor plus the next declared values, and the difference is disclosed per
// axis (`declaredValues` vs `measuredValues`).
export const MAX_MATRIX_AXIS_VALUES = 8;

function matrixValueCount(schema: PropSchema): number {
  if (schema.kind === "boolean") return 2;
  return Math.min(schema.values.length, MAX_MATRIX_AXIS_VALUES);
}


export function shouldAutoActivateMatrix(schemas: PropSchema[]): boolean {
  const eligible = schemas.filter(isMatrixEligible);
  if (eligible.length < 2) return false;
  const product = eligible.reduce((acc, s) => acc * matrixValueCount(s), 1);
  return product <= MAX_MATRIX_AUTO_CELLS;
}

// M104 / I10: exported so `runMatrixMode` derives the values it prints as an
// axis from the same function the cells are generated from, rather than a
// second inline copy of the predicate.
export function matrixValues(schema: PropSchema): unknown[] {
  if (schema.kind === "boolean") return [false, true];
  const declared = schema.values;
  if (declared.length <= MAX_MATRIX_AXIS_VALUES) return declared;
  // The anchor is the value the component itself defaults to when it declares
  // one, so the anchor cell is the component's own resting state; otherwise the
  // first declared value, matching `resolveAnchorValue`. The rest follow in
  // declaration order.
  const anchorIndex =
    schema.defaultValue === undefined
      ? 0
      : Math.max(
          0,
          declared.findIndex((value) => Object.is(value, schema.defaultValue)),
        );
  const rest = declared.filter((_, index) => index !== anchorIndex);
  return [declared[anchorIndex], ...rest.slice(0, MAX_MATRIX_AXIS_VALUES - 1)];
}

// Every value the axis declares, as the schema declares them.
export function matrixDeclaredValues(schema: PropSchema): unknown[] {
  return schema.kind === "boolean" ? [false, true] : schema.values;
}

// M104 / I10 (dub-F7): the axes a matrix crosses, with what each one declares
// beside what it measures, so the report can say "variant: 8 of 12 values
// crossed" instead of presenting the truncation as the whole contract.
export interface MatrixAxisValues {
  propName: string;
  // What the cells actually cross. Identical to `measuredValues`; kept so this
  // satisfies `MatrixAxisLike` for `selectMatrixCombos`.
  values: unknown[];
  declaredValues: unknown[];
  measuredValues: unknown[];
}

export function matrixAxesFor(schemas: PropSchema[]): MatrixAxisValues[] {
  return schemas.filter(isMatrixEligible).map((schema) => {
    const measuredValues = matrixValues(schema);
    return {
      propName: schema.name,
      values: measuredValues,
      declaredValues: matrixDeclaredValues(schema),
      measuredValues,
    };
  });
}

// M104 / I10 (dub-F1): a prop the matrix does not vary is not a free variable.
// dub's Switch declares `disabledTooltip?: string | ReactNode`, and
// `resolveAnchorValue` fixed it at the truthy `"120fps-placeholder"` in every
// cell, so every cell entered the `<Tooltip>` branch and failed for a reason no
// axis named. An optional non-axis prop holds the default the component
// declares, or is absent. A required one stays present with its anchor value:
// an absent required prop is a guaranteed crash (M86), not a cleaner cell.
// M104 / I10 (review B-1): "absent" is for a SYNTHESIZED stand-in only. A value
// the user wrote in `<stem>.props.tsx` (`provenance: "preset"`) is the whole
// point of M98's primevue closure, and a content slot is what the component
// renders -- dropping either measured a component with no content while combo
// mode still measured it, so the two modes disagreed about the same component.
const CONTENT_SLOT_NAME = /^(children|label)$/;

function isContentSlot(schema: PropSchema): boolean {
  if (CONTENT_SLOT_NAME.test(schema.name)) return true;
  return (
    (schema.kind === "reactnode" || schema.kind === "string") && schema.provenance === "declared"
  );
}

function matrixNonAxisValue(schema: PropSchema): { present: boolean; value?: unknown } {
  if (schema.defaultSource !== undefined) {
    return schema.defaultValue === undefined
      ? { present: false }
      : { present: true, value: schema.defaultValue };
  }
  if (schema.required) return { present: true, value: resolveAnchorValue(schema) };
  if (schema.provenance === "preset") return { present: true, value: resolveAnchorValue(schema) };
  if (isContentSlot(schema)) return { present: true, value: resolveAnchorValue(schema) };
  return { present: false };
}

// M104 / I10 (review B-1): the non-axis props no cell carries, so the matrix
// header can say so. A cell that silently lost a prop reads as a cell the
// component rendered without it.
export function matrixHeldAbsentProps(schemas: PropSchema[]): string[] {
  return schemas
    .filter((schema) => !isMatrixEligible(schema) && !matrixNonAxisValue(schema).present)
    .map((schema) => schema.name);
}

export function generatePropMatrix(schemas: PropSchema[]): PropCombination[] {
  if (schemas.length === 0) return [{}];

  const eligible = schemas.filter(isMatrixEligible);
  const anchorProps: PropCombination = {};
  for (const s of schemas) {
    if (isMatrixEligible(s)) continue;
    const held = matrixNonAxisValue(s);
    if (held.present) anchorProps[s.name] = held.value;
  }

  if (eligible.length === 0) {
    const combo: PropCombination = { ...anchorProps };
    return [combo];
  }

  const axes = eligible.map((s) => ({ name: s.name, values: matrixValues(s) }));
  const product = axes.reduce((acc, a) => acc * a.values.length, 1);

  let matrixCells: PropCombination[];
  if (product <= MAX_MATRIX_CELLS) {
    matrixCells = matrixCartesian(axes);
  } else {
    // M104 / I10: `pairwiseCover` optimizes for pair coverage and need not
    // produce the all-first-value row at all. `--max-combos` promises the
    // anchor cell survives every cap (cli.ts), so it is generated here rather
    // than hoped for.
    matrixCells = withAnchorCell(pairwiseCover(axes, MAX_MATRIX_CELLS), axes);
  }

  return matrixCells.map((cell) => ({ ...anchorProps, ...cell }));
}

function matrixCartesian(axes: { name: string; values: unknown[] }[]): PropCombination[] {
  const results: PropCombination[] = [];
  const indices = new Array(axes.length).fill(0) as number[];

  while (true) {
    const combo: PropCombination = {};
    for (let i = 0; i < axes.length; i++) {
      combo[axes[i].name] = axes[i].values[indices[i]];
    }
    results.push(combo);

    let carry = axes.length - 1;
    while (carry >= 0) {
      indices[carry]++;
      if (indices[carry] < axes[carry].values.length) break;
      indices[carry] = 0;
      carry--;
    }
    if (carry < 0) break;
  }

  return results;
}

export function pairwiseCover(
  axes: { name: string; values: unknown[] }[],
  maxRows: number,
): PropCombination[] {
  if (axes.length <= 1) return matrixCartesian(axes);

  type Pair = string;
  const allPairs = new Set<Pair>();
  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      for (const vi of axes[i].values) {
        for (const vj of axes[j].values) {
          allPairs.add(pairKey(i, vi, j, vj));
        }
      }
    }
  }

  const uncovered = new Set(allPairs);

  // M104 / I10 (twenty-F3): the greedy pair-covering rows below differ from the
  // anchor on two axes at once, so with ten eligible axes the cover contained
  // no distance-1 cell at all and `selectMatrixCombos`'s deviation rule had no
  // candidate to promote -- twenty's Modal kept two cells that both carried
  // `isOpen: false`, the state the run itself reports as rendering nothing. The
  // cover is therefore seeded with the anchor plus one single-axis deviation
  // per axis, so a small `--max-combos` crosses one axis at a time here exactly
  // as it does under `matrixCartesian`. Pair covering then fills whatever
  // budget is left; the seeds already cover a share of the pairs, so nothing is
  // measured twice.
  const anchorRow: PropCombination = {};
  for (const axis of axes) anchorRow[axis.name] = axis.values[0];
  const rows: PropCombination[] = [{ ...anchorRow }];
  for (const axis of axes) {
    if (rows.length >= maxRows) break;
    // Review B-12: a second value that is literally `undefined` is the prop's
    // own absence, not a deviation worth a cell of the budget.
    if (axis.values.length < 2) continue;
    const deviation = axis.values[1];
    if (deviation === undefined) continue;
    rows.push({ ...anchorRow, [axis.name]: deviation });
  }
  for (const row of rows) {
    for (let i = 0; i < axes.length; i++) {
      for (let j = i + 1; j < axes.length; j++) {
        uncovered.delete(pairKey(i, row[axes[i].name], j, row[axes[j].name]));
      }
    }
  }

  while (uncovered.size > 0 && rows.length < maxRows) {
    let bestRow: PropCombination | null = null;
    let bestScore = -1;

    for (let attempt = 0; attempt < axes.length * 10; attempt++) {
      const candidate: PropCombination = {};
      for (let a = 0; a < axes.length; a++) {
        candidate[axes[a].name] = axes[a].values[attempt % axes[a].values.length];
      }

      for (let a = 0; a < axes.length; a++) {
        let bestVal = candidate[axes[a].name];
        let bestCover = 0;
        for (const v of axes[a].values) {
          candidate[axes[a].name] = v;
          const cover = countCoveredPairs(candidate, axes, uncovered);
          if (cover > bestCover) {
            bestCover = cover;
            bestVal = v;
          }
        }
        candidate[axes[a].name] = bestVal;
      }

      const score = countCoveredPairs(candidate, axes, uncovered);
      if (score > bestScore) {
        bestScore = score;
        bestRow = { ...candidate };
      }
    }

    if (!bestRow || bestScore === 0) break;
    rows.push(bestRow);

    for (let i = 0; i < axes.length; i++) {
      for (let j = i + 1; j < axes.length; j++) {
        uncovered.delete(pairKey(i, bestRow[axes[i].name], j, bestRow[axes[j].name]));
      }
    }
  }

  return rows;
}

function pairKey(i: number, vi: unknown, j: number, vj: unknown): string {
  return `${i}:${JSON.stringify(vi)}|${j}:${JSON.stringify(vj)}`;
}

function countCoveredPairs(
  row: PropCombination,
  axes: { name: string; values: unknown[] }[],
  uncovered: Set<string>,
): number {
  let count = 0;
  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      if (uncovered.has(pairKey(i, row[axes[i].name], j, row[axes[j].name]))) {
        count++;
      }
    }
  }
  return count;
}

// Structurally identical to report.ts's `MatrixAxis`; declared locally so
// this module gains no dependency on report.ts for one shape.
export interface MatrixAxisLike {
  propName: string;
  values: unknown[];
}

// M61: --max-combos never bounded matrix cells at all. Capping needs an
// order: keep the all-anchor base cell (every axis at its first/anchor
// value: never dropped), then cells one axis away from it (the same
// single-prop-effect story --max-combos already tells in plain-combo mode),
// then two axes away, and so on. Ties keep generation order, so a
// lexicographic cartesian or a pairwise-cover fallback both cap
// predictably. This selects over an already-generated cell set; it does not
// change generatePropMatrix's generation or cell ordering.
// M104 / I10 (twenty-F3, dub-F7): an axis whose flip is what makes the
// component render anything. `Modal.isOpen` anchors at `false`, the state the
// run itself reports as rendering nothing, so a two-cell cap that kept the
// cartesian-adjacent cell measured two empty renders and passed. Boolean and
// falsy-anchored are structural; the name list is the convention this reads as
// "off by default, on is the interesting state".
const REVEAL_AXIS_NAME = /^(is|has|show|open|visible|expanded|active|enabled)/i;

function isRevealAxis(axis: MatrixAxisLike): boolean {
  if (!REVEAL_AXIS_NAME.test(axis.propName)) return false;
  if (axis.values.length !== 2) return false;
  if (!axis.values.every((value) => typeof value === "boolean")) return false;
  return !axis.values[0];
}

// M104 / I10: the all-first-value cell, added when the generator did not
// produce it. Placed first so it is also the first cell the cap keeps.
function withAnchorCell(
  cells: PropCombination[],
  axes: { name: string; values: unknown[] }[],
): PropCombination[] {
  const anchor: PropCombination = {};
  for (const axis of axes) anchor[axis.name] = axis.values[0];
  const isAnchor = (cell: PropCombination): boolean =>
    axes.every((axis) => comboKey(cell[axis.name]) === comboKey(anchor[axis.name]));
  return cells.some(isAnchor) ? cells : [anchor, ...cells];
}

export function selectMatrixCombos(
  combos: PropCombination[],
  axes: MatrixAxisLike[],
  max: number,
): number[] {
  if (max <= 0) return [];
  if (combos.length <= max) return combos.map((_, i) => i);

  const anchor: PropCombination = {};
  for (const axis of axes) anchor[axis.propName] = axis.values[0];

  const deviates = (combo: PropCombination, axis: MatrixAxisLike): boolean =>
    comboKey(combo[axis.propName]) !== comboKey(anchor[axis.propName]);

  const distance = (combo: PropCombination): number =>
    axes.reduce((acc, axis) => acc + (deviates(combo, axis) ? 1 : 0), 0);

  // M104 / I10: `matrixCartesian` increments the LAST axis fastest, so cell
  // index 1 always deviates on the last-declared axis and the first-declared
  // one -- the component's own prop, after M103's ranking -- was never crossed
  // at a small cap. Order is: the anchor, then a reveal flip, then the
  // earliest-declared axis.
  const revealsSomething = (combo: PropCombination): 0 | 1 =>
    axes.some((axis) => isRevealAxis(axis) && deviates(combo, axis)) ? 0 : 1;

  const firstDeviatingAxis = (combo: PropCombination): number => {
    const found = axes.findIndex((axis) => deviates(combo, axis));
    return found === -1 ? axes.length : found;
  };

  const ranked = combos
    .map((combo, index) => ({
      index,
      distance: distance(combo),
      reveal: revealsSomething(combo),
      axis: firstDeviatingAxis(combo),
    }))
    .sort(
      (a, b) =>
        a.distance - b.distance || a.reveal - b.reveal || a.axis - b.axis || a.index - b.index,
    );

  // Breadth before depth: a 3-value union axis contributes two single-axis
  // deviations, and taking both before any other axis is crossed spends the cap
  // on one prop. One cell per axis is taken first, in the order above, then the
  // remainder fills whatever budget is left.
  const picked: number[] = [];
  const takenAxes = new Set<number>();
  for (const cell of ranked) {
    if (picked.length >= max) break;
    if (takenAxes.has(cell.axis)) continue;
    takenAxes.add(cell.axis);
    picked.push(cell.index);
  }
  for (const cell of ranked) {
    if (picked.length >= max) break;
    if (picked.includes(cell.index)) continue;
    picked.push(cell.index);
  }

  return picked.sort((a, b) => a - b);
}

export const DEFAULT_MEASURED_COMBOS = 8;

// `generateCombinations` stratifies its sample across the value space, so a
// prefix throws that work away. Keep the ends and spread the rest.
export function selectRepresentativeCombos(count: number, max: number): number[] {
  if (count <= 0 || max <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  if (max === 1) return [0];
  const picked: number[] = [];
  for (let i = 0; i < max; i++) {
    picked.push(Math.round((i * (count - 1)) / (max - 1)));
  }
  return [...new Set(picked)];
}
