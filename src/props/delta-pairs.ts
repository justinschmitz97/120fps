import type { PropSchema } from "./schema.js";
import { resolveAnchorValue, type PropCombination } from "./values.js";

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
      // A degenerate schema has no real value to flip to (base and
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

