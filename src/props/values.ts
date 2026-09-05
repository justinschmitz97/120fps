import { cloneDeep } from "../shared/index.js";
import type { PropSchema, ScalingPropMatch } from "./schema.js";

export type PropCombination = Record<string, unknown>;

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

// Each element gets its own identity, as a component keying or mutating them expects.
export function fillArray(schema: PropSchema, n: number): unknown[] {
  const template = schema.elementTemplate;
  if (template === undefined) {
    return Array.from({ length: n }, (_, i) => `item-${i + 1}`);
  }
  return Array.from({ length: n }, () => cloneDeep(template));
}

// The run and --explain-props must agree the prop is unusable, so it is omitted rather than faked.
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

// Two combos with one key would time the same render twice and report as distinct rows.
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

  // The pools are already de-duplicated; this catches a future source cheaply, before the cap.
  if (total <= MAX_COMBINATIONS) {
    return dedupeCombos(cartesian(schemas, valuesByProp));
  }

  return dedupeCombos(stratifiedSample(schemas, valuesByProp, MAX_COMBINATIONS));
}

// The uncapped product; it can exceed exact float range, so a caller must bound the display.
export function countCombinationSpace(schemas: PropSchema[]): number {
  const valuesByProp = schemas.map((s) => resolveValues(s));
  return valuesByProp.reduce((acc, v) => acc * v.length, 1);
}

// An optional prop is worth measuring absent once; a second `undefined` would double the space.
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
  // A literal union is an axis at any arity; matrixValues truncates instead of excluding it.
  if (schema.kind === "union" && schema.values.length >= 1) return true;
  return false;
}

// Beyond this an axis keeps its anchor plus the next values; declaredValues discloses the rest.
export const MAX_MATRIX_AXIS_VALUES = 8;

function matrixValueCount(schema: PropSchema): number {
  if (schema.kind === "boolean") return 2;
  return Math.min(schema.values.length, MAX_MATRIX_AXIS_VALUES);
}


export function shouldAutoActivateMatrix(schemas: PropSchema[]): boolean {
  const eligible = matrixAxisSchemas(schemas);
  if (eligible.length < 2) return false;
  const product = eligible.reduce((acc, s) => acc * matrixValueCount(s), 1);
  return product <= MAX_MATRIX_AUTO_CELLS;
}

// `defaultOpen` is `open`'s uncontrolled twin, and a component receiving both rejects it.
const UNCONTROLLED_TWIN = /^default([A-Z]\w*)$/;

function controlledTwinOf(name: string): string | undefined {
  const match = UNCONTROLLED_TWIN.exec(name);
  if (!match) return undefined;
  return match[1][0].toLowerCase() + match[1].slice(1);
}

// One function, so the cells, the header and the held-absent line describe the same set.
export function matrixAxisSchemas(schemas: PropSchema[]): PropSchema[] {
  const dropped = droppedTwinNames(schemas);
  return schemas.filter((schema) => isMatrixEligible(schema) && !dropped.has(schema.name));
}

// A dropped twin is held absent: pinning it beside its controlled member breaks the component.
export function droppedTwinNames(schemas: PropSchema[]): Set<string> {
  const eligibleNames = new Set(schemas.filter(isMatrixEligible).map((schema) => schema.name));
  const dropped = new Set<string>();
  for (const schema of schemas) {
    const controlled = controlledTwinOf(schema.name);
    if (controlled !== undefined && eligibleNames.has(controlled)) dropped.add(schema.name);
  }
  return dropped;
}

export function matrixValues(schema: PropSchema): unknown[] {
  // An optional boolean crosses absent against the state the component does not already do.
  if (schema.kind === "boolean")
    return schema.required ? [false, true] : [undefined, schema.defaultValue === true ? false : true];
  const declared = schema.values;
  if (declared.length <= MAX_MATRIX_AXIS_VALUES) return declared;
  // The anchor is the component's declared default, so the anchor cell is its resting state.
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

// A boolean axis declares exactly what it measures.
export function matrixDeclaredValues(schema: PropSchema): unknown[] {
  return schema.kind === "boolean" ? matrixValues(schema) : schema.values;
}

// Declared beside measured, so the report can say "8 of 12 values crossed".
export interface MatrixAxisValues {
  propName: string;
  // Identical to measuredValues; kept so this satisfies MatrixAxisLike for selectMatrixCombos.
  values: unknown[];
  declaredValues: unknown[];
  measuredValues: unknown[];
}

export function matrixAxesFor(schemas: PropSchema[]): MatrixAxisValues[] {
  return matrixAxisSchemas(schemas).map((schema) => {
    const measuredValues = matrixValues(schema);
    return {
      propName: schema.name,
      values: measuredValues,
      declaredValues: matrixDeclaredValues(schema),
      measuredValues,
    };
  });
}

// A content slot is what the component renders; dropping it would measure an empty component.
const CONTENT_SLOT_NAME = /^(children|label)$/;

function isContentSlot(schema: PropSchema): boolean {
  if (CONTENT_SLOT_NAME.test(schema.name)) return true;
  return (
    (schema.kind === "reactnode" || schema.kind === "string") && schema.provenance === "declared"
  );
}

// Holding an optional prop at a truthy value would make every cell take the same branch.
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

// A cell that silently lost a prop reads as a cell the component rendered without it.
export function matrixHeldAbsentProps(schemas: PropSchema[]): string[] {
  const axisNames = new Set(matrixAxisSchemas(schemas).map((schema) => schema.name));
  const dropped = droppedTwinNames(schemas);
  return schemas
    .filter(
      (schema) =>
        !axisNames.has(schema.name) &&
        (dropped.has(schema.name) || !matrixNonAxisValue(schema).present),
    )
    .map((schema) => schema.name);
}

export function generatePropMatrix(schemas: PropSchema[]): PropCombination[] {
  if (schemas.length === 0) return [{}];

  const eligible = matrixAxisSchemas(schemas);
  const axisNames = new Set(eligible.map((schema) => schema.name));
  const droppedTwins = droppedTwinNames(schemas);
  const anchorProps: PropCombination = {};
  for (const s of schemas) {
    if (axisNames.has(s.name) || droppedTwins.has(s.name)) continue;
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
    // pairwiseCover need not produce the anchor row, which --max-combos promises to keep.
    matrixCells = withAnchorCell(pairwiseCover(axes, MAX_MATRIX_CELLS), axes);
  }

  // A cell carrying `open: undefined` would still be a cell that passed the prop.
  return matrixCells.map((cell) => {
    const merged: PropCombination = { ...anchorProps };
    for (const [name, value] of Object.entries(cell)) {
      if (value !== undefined) merged[name] = value;
    }
    return merged;
  });
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

  // Seeded with the anchor plus one single-axis deviation, so a small cap crosses one at a time.
  const anchorRow: PropCombination = {};
  for (const axis of axes) anchorRow[axis.name] = axis.values[0];
  const rows: PropCombination[] = [{ ...anchorRow }];
  for (const axis of axes) {
    if (rows.length >= maxRows) break;
    // A second value of `undefined` is the prop's absence, not a deviation worth a cell.
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

// Structurally identical to report/types.ts's MatrixAxis; local so props never imports report.
export interface MatrixAxisLike {
  propName: string;
  values: unknown[];
}

// An axis whose flip makes the component render anything; `Modal.isOpen` anchors at `false`.
const REVEAL_AXIS_NAME = /^(is|has|show|open|visible|expanded|active|enabled)/i;

function isRevealAxis(axis: MatrixAxisLike): boolean {
  if (!REVEAL_AXIS_NAME.test(axis.propName)) return false;
  if (axis.values.length !== 2) return false;
  // An optional boolean's off state is absence, still the state whose flip reveals something.
  if (!axis.values.every((value) => typeof value === "boolean" || value === undefined)) return false;
  return !axis.values[0];
}

// Placed first so the anchor cell is also the first cell the cap keeps.
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

// Capping needs an order: the anchor cell, then cells one axis away, then two; ties by generation.
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

  // matrixCartesian increments the last axis fastest, so a small cap would never cross the first.
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

  // Breadth before depth: one cell per axis first, or a 3-value axis spends the cap on one prop.
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

// generateCombinations stratifies its sample, so a prefix would throw that work away.
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
