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
    } else if (s.kind === "object" && !s.required) {
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

export function resolveAnchorValue(schema: PropSchema): unknown {
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
  if (schema.kind === "union" && schema.values.length >= 1 && schema.values.length <= 8) return true;
  return false;
}

function matrixValueCount(schema: PropSchema): number {
  if (schema.kind === "boolean") return 2;
  return schema.values.length;
}

export function shouldAutoActivateMatrix(schemas: PropSchema[]): boolean {
  const eligible = schemas.filter(isMatrixEligible);
  if (eligible.length < 2) return false;
  const product = eligible.reduce((acc, s) => acc * matrixValueCount(s), 1);
  return product <= MAX_MATRIX_AUTO_CELLS;
}

function matrixValues(schema: PropSchema): unknown[] {
  if (schema.kind === "boolean") return [false, true];
  return schema.values;
}

export function generatePropMatrix(schemas: PropSchema[]): PropCombination[] {
  if (schemas.length === 0) return [{}];

  const eligible = schemas.filter(isMatrixEligible);
  const anchorProps: PropCombination = {};
  for (const s of schemas) {
    if (!isMatrixEligible(s)) {
      anchorProps[s.name] = resolveAnchorValue(s);
    }
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
    matrixCells = pairwiseCover(axes, MAX_MATRIX_CELLS);
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
  const rows: PropCombination[] = [];

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
export function selectMatrixCombos(
  combos: PropCombination[],
  axes: MatrixAxisLike[],
  max: number,
): number[] {
  if (max <= 0) return [];
  if (combos.length <= max) return combos.map((_, i) => i);

  const anchor: PropCombination = {};
  for (const axis of axes) anchor[axis.propName] = axis.values[0];

  const distance = (combo: PropCombination): number =>
    axes.reduce(
      (acc, axis) => acc + (comboKey(combo[axis.propName]) === comboKey(anchor[axis.propName]) ? 0 : 1),
      0,
    );

  const ranked = combos
    .map((combo, index) => ({ index, distance: distance(combo) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index);

  return ranked.slice(0, max).map((r) => r.index).sort((a, b) => a - b);
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
