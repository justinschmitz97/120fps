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

function resolveAnchorValue(schema: PropSchema): unknown {
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
