import type { PropSchema, ScalingPropMatch } from "./prop-gen.js";

export type PropCombination = Record<string, unknown>;

export interface DeltaPair {
  propName: string;
  baseCombo: PropCombination;
  flipCombo: PropCombination;
  baseValue: unknown;
  flipValue: unknown;
}

const MAX_DELTA_PAIRS = 128;

export function generateDeltaPairs(schemas: PropSchema[]): DeltaPair[] {
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

  const all = [...boolPairs, ...unionPairs, ...objectPairs];
  return all.slice(0, MAX_DELTA_PAIRS);
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
      combo[match.schema.name] = Array.from({ length: n }, (_, i) => `item-${i + 1}`);
    }
    return combo;
  });
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

export function generateCombinations(schemas: PropSchema[]): PropCombination[] {
  const valuesByProp = schemas.map((s) => resolveValues(s));

  const total = valuesByProp.reduce((acc, v) => acc * v.length, 1);

  if (total <= MAX_COMBINATIONS) {
    return cartesian(schemas, valuesByProp);
  }

  return stratifiedSample(schemas, valuesByProp, MAX_COMBINATIONS);
}

function resolveValues(schema: PropSchema): unknown[] {
  const base = resolveBaseValues(schema);
  if (!schema.required) {
    return [...base, undefined];
  }
  return base;
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
      return [[], ["item-1", "item-2", "item-3"]];
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
