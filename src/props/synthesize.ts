import path from "node:path";
import ts from "typescript";
import { isElementOrCallableUnion, isObjectLike, MAX_TUPLE_ARITY, presetRemedyClause } from "./classify.js";
import { emit } from "./extract.js";
import { isNoiseName } from "./program.js";

// M103 (dub-F2, corpus re-test): a REQUIRED prop typed as a class or an
// interface with methods gets a placeholder object -- dub's Table declares
// `table: TableType<T>`, the harness synthesizes `{}`, and the render dies on
// `table.getVisibleLeafColumns is not a function` with nothing said in either
// mode. `warnDegenerateProps` covers the case where synthesis gave up outright;
// this covers the one where it produced something the component cannot use.
// Same family, same remedy.
const REQUIRED_OBJECT_SYNTHESIS_MARK = "is measured with a synthesized stand-in";


export const SYNTHESIZED_REQUIRED_OBJECT_WARNING = (
  absolutePath: string,
  propName: string,
  typeText: string,
): string =>
  `Warning: required prop "${propName}" in ${absolutePath} is typed ${typeText}, which no ` +
  `synthesized value can satisfy, so it ${REQUIRED_OBJECT_SYNTHESIS_MARK}: the component receives an ` +
  `object with none of that type's methods.` +
  presetRemedyClause(absolutePath) +
  "\n";


export function isSynthesizedRequiredObjectWarning(message: string): boolean {
  return message.includes(REQUIRED_OBJECT_SYNTHESIS_MARK);
}


// A type whose own members include a callable one. A synthesized stand-in gives
// the component the fields and none of the methods, which is the shape that
// crashes on first use rather than rendering something wrong.
export function hasMethodMembers(type: ts.Type): boolean {
  return type
    .getProperties()
    .some((member) =>
      (member.getDeclarations() ?? []).some(
        (declaration) =>
          ts.isMethodSignature(declaration) ||
          ts.isMethodDeclaration(declaration) ||
          (ts.isPropertySignature(declaration) &&
            declaration.type !== undefined &&
            ts.isFunctionTypeNode(declaration.type)),
      ),
    );
}


export function warnSynthesizedRequiredObject(
  fileName: string,
  propName: string,
  typeText: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::required-object::${propName}`,
    SYNTHESIZED_REQUIRED_OBJECT_WARNING(fileName, propName, typeText),
    sink,
  );
}


// TypeScript's own libs and React's type packages: between them they declare
// the ~300 DOM/ARIA members every `ComponentProps` drags in. A property
// declared anywhere else in node_modules is a design-system prop and is kept.
const DEFAULT_LIB_FILE = /[\\/]lib\.[^\\/]*\.d\.ts$/i;

export const REACT_TYPE_PACKAGE = /[\\/]node_modules[\\/](@types[\\/])?react(-dom)?[\\/]/i;


function isDefaultLibFile(fileName: string): boolean {
  return DEFAULT_LIB_FILE.test(fileName);
}


function isAmbientNoiseDeclaration(decl: ts.Declaration): boolean {
  const fileName = decl.getSourceFile().fileName;
  return isDefaultLibFile(fileName) || REACT_TYPE_PACKAGE.test(fileName);
}


function isNoiseProp(prop: ts.Symbol): boolean {
  if (isNoiseName(prop.getName())) return true;
  const decls = prop.getDeclarations();
  if (!decls || decls.length === 0) return false;
  return decls.every(isAmbientNoiseDeclaration);
}


const SYNTH_MAX_DEPTH = 3;

// A props-level object starts one level above an array element: `board.cells[]`
// is three hops from the prop and still ordinary domain data.
export const PROP_SYNTH_MAX_DEPTH = 4;

const SYNTH_MAX_PROPS = 24;


interface SynthContext {
  maxDepth: number;
  // Types on the current path: a recursive type is not re-entered.
  stack: ts.Type[];
  // Members that could not be reproduced faithfully, for the caller's warning.
  notes: string[];
  // M84: whether any nested member's value came from a name-based heuristic
  // (`namedStringValue`) or a generic type-agnostic fallback, so the outer
  // object schema's own `provenance` can reflect the riskiest thing it
  // contains rather than always reading "declared".
  usedHeuristic: boolean;
  usedPlaceholder: boolean;
}


export function newSynth(maxDepth = SYNTH_MAX_DEPTH): SynthContext {
  return { maxDepth, stack: [], notes: [], usedHeuristic: false, usedPlaceholder: false };
}


const MAP_TYPES = new Set(["Map", "WeakMap", "ReadonlyMap"]);

const SET_TYPES = new Set(["Set", "WeakSet", "ReadonlySet"]);

// M81 3a: a structural iterable that is neither Map nor Set. Unlike them, a
// real array IS a valid `Iterable<T>` and survives Playwright's serializer
// unchanged, so it carries no `reason` and is not marked degenerate.
const ITERABLE_TYPES = new Set(["Iterable", "IterableIterator"]);

const COLLECTION_ENTRIES = 2;


// The declared name of a built-in type, or undefined for anything a user wrote.
// Synthetic symbols (`__type` for the anonymous mapped type behind `Record`)
// name no type and are left to the ordinary object path.
function builtinName(type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  const decls = symbol?.getDeclarations();
  if (!symbol || !decls || decls.length === 0) return undefined;
  const name = symbol.getName();
  if (name.startsWith("__")) return undefined;
  return decls.some((d) => isDefaultLibFile(d.getSourceFile().fileName)) ? name : undefined;
}


// Playwright's evaluate serializer has no case for Map or Set (verified in
// playwright-core lib/utils/isomorphic/utilityScriptSerializers.js), so a real
// instance would reach the page as `{}`. The entries travel instead, and the
// prop is reported as degenerate rather than pretending to be an empty object.
export function collectionValue(
  type: ts.Type,
  checker: ts.TypeChecker,
): { value: unknown; reason?: string } | undefined {
  const name = builtinName(type);
  if (!name) return undefined;

  // M81 3a: a real array is a valid `Iterable<T>`/`IterableIterator<T>` and
  // does not throw inside `new Set(prop)`; unlike Map/Set it needs no
  // entries-transport `reason` and is not marked degenerate.
  if (ITERABLE_TYPES.has(name)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    const element = args[0] ? synthesizeValue(args[0], checker, 1, newSynth()) : undefined;
    return { value: distinctValues(element) };
  }

  if (!MAP_TYPES.has(name) && !SET_TYPES.has(name)) return undefined;

  const args = checker.getTypeArguments(type as ts.TypeReference);
  const reason = `${name} cannot be transported to the browser: passed as entries`;

  if (SET_TYPES.has(name)) {
    const member = args[0] ? synthesizeValue(args[0], checker, 1, newSynth()) : undefined;
    return { value: distinctValues(member), reason };
  }

  const key = args[0] ? synthesizeValue(args[0], checker, 1, newSynth()) : undefined;
  const value = args[1] ? synthesizeValue(args[1], checker, 1, newSynth()) : undefined;
  return {
    value: distinctValues(key).map((k) => [k, cloneSynthesized(value)]),
    reason,
  };
}


// Two entries that a component can tell apart; a shape with no distinguishable
// key collapses to a single entry rather than inventing collisions.
function distinctValues(seed: unknown): unknown[] {
  if (typeof seed === "string") {
    return Array.from({ length: COLLECTION_ENTRIES }, (_, i) => `${seed}-${i + 1}`);
  }
  if (typeof seed === "number") {
    return Array.from({ length: COLLECTION_ENTRIES }, (_, i) => seed + i);
  }
  if (seed === undefined) return [];
  return [seed];
}


function cloneSynthesized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSynthesized);
  if (value instanceof Date) return new Date(value.getTime());
  if (value && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneSynthesized(v);
    }
    return out;
  }
  return value;
}


// Fixed instants and patterns, so a component that formats them gets real work
// to do. Both survive Playwright's serializer.
const SYNTH_DATE = "2024-01-01T00:00:00.000Z";


export function instanceValue(type: ts.Type): unknown {
  const name = builtinName(type);
  if (name === "Date") return new Date(SYNTH_DATE);
  if (name === "RegExp") return /120fps/;
  return undefined;
}


// Anything whose behaviour is its shape: a class instance is its methods, a
// Promise is its resolution, a DOM node is the document it lives in. Inventing
// a field bag for them produces a value the component crashes on.
export function opaqueReason(type: ts.Type, checker: ts.TypeChecker): string | undefined {
  const symbol = type.getSymbol();
  const decls = symbol?.getDeclarations() ?? [];
  if (decls.some((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d))) {
    return `${checker.typeToString(type)} is a class instance`;
  }
  const name = builtinName(type);
  if (name && !MAP_TYPES.has(name) && !SET_TYPES.has(name) && !ITERABLE_TYPES.has(name)) {
    return `${name} has no synthesizable shape`;
  }
  // M81 3b: `ReactElement | (props) => ReactElement` (Base UI's `render`
  // idiom): a function/element union has no synthesizable field-bag shape.
  if (isElementOrCallableUnion(type, checker)) {
    return `${checker.typeToString(type)} requires a real element or render function`;
  }
  return undefined;
}


// An array whose elements are strings satisfies no object-shaped element type,
// so a scaling sweep over it renders nothing and reports constant growth.
// Build one value shaped like the declared element instead.
export function synthesizeElement(arrayType: ts.Type, checker: ts.TypeChecker): unknown {
  const element = checker.getTypeArguments(arrayType as ts.TypeReference)[0];
  if (!element) return undefined;
  return synthesizeValue(element, checker, 0, newSynth());
}


// M84: `name` is the prop or field this value is being synthesized for, when
// one is known — the object-property loop below passes `prop.name`; every
// other recursive call (union members, tuple positions, array elements,
// Map/Set/Iterable entries) has no single field name to offer and passes
// `undefined`, where the generic fallback is correct because there is no
// name to test a heuristic against. This is the ONLY place besides
// `classifyType`'s own top-level string branch that decides a string value,
// and both call the same `namedStringValue`, so a heuristic added there
// applies at every depth without a second copy to keep in sync (M84's
// depth-independence invariant).
export function synthesizeValue(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  synth: SynthContext,
  name?: string,
): unknown {
  if (depth >= synth.maxDepth) return undefined;

  if (type.isStringLiteral()) return type.value;
  if (type.isNumberLiteral()) return type.value;
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return checker.typeToString(type) === "true";
  }
  if (type.flags & ts.TypeFlags.String) {
    const named = namedStringValue(name);
    if (named !== undefined) {
      synth.usedHeuristic = true;
      return named;
    }
    synth.usedPlaceholder = true;
    return "text";
  }
  if (type.flags & ts.TypeFlags.Number) return 1;
  if (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLike)) return true;
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    return undefined;
  }

  if (type.isUnion()) {
    for (const member of type.types) {
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      const value = synthesizeValue(member, checker, depth, synth, name);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  if (checker.isTupleType(type)) {
    const positions = checker
      .getTypeArguments(type as ts.TypeReference)
      .slice(0, MAX_TUPLE_ARITY);
    if (positions.length === 0) return undefined;
    return positions.map((position) => synthesizeValue(position, checker, depth + 1, synth));
  }

  if (checker.isArrayType(type)) {
    const inner = checker.getTypeArguments(type as ts.TypeReference)[0];
    if (!inner) return [];
    const value = synthesizeValue(inner, checker, depth + 1, synth);
    return value === undefined ? [] : [value];
  }

  if (isObjectLike(type)) {
    // Functions and other callables have no data shape worth inventing.
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) {
      return undefined;
    }
    const instance = instanceValue(type);
    if (instance !== undefined) return instance;
    const collection = collectionValue(type, checker);
    if (collection) {
      if (collection.reason) synth.notes.push(collection.reason);
      return collection.value;
    }
    const opaque = opaqueReason(type, checker);
    if (opaque) {
      synth.notes.push(opaque);
      return undefined;
    }
    // A type already on the path is a cycle; the depth cap alone would only
    // bound it, and a bounded cycle is still fabricated nesting.
    if (synth.stack.includes(type)) return undefined;

    const props = checker
      .getPropertiesOfType(type)
      .filter((prop) => !isNoiseProp(prop))
      .slice(0, SYNTH_MAX_PROPS);
    if (props.length === 0) return undefined;

    synth.stack.push(type);
    try {
      const record: Record<string, unknown> = {};
      for (const prop of props) {
        record[prop.name] = synthesizeValue(
          checker.getTypeOfSymbol(prop),
          checker,
          depth + 1,
          synth,
          prop.name,
        );
      }
      return record;
    } finally {
      synth.stack.pop();
    }
  }

  return undefined;
}


// M81 3d: commerce-F1. Named runtime-validated string conventions, matched
// before falling back to the generic "test" placeholder. Deliberately narrow:
// closes the one repeatedly-observed false-FAIL class (Intl construction),
// not a general claim that every runtime-validated string is now safe.
const CURRENCY_PROP_NAME = /^currency(code)?$/i;

const LOCALE_PROP_NAME = /^(locale|language)$/i;

// M84: element-plus-F2. A `src`/`srcSet`/`poster` string synthesized as the
// generic "test" placeholder relative-resolves against the harness origin
// and 404s, and the 404 is then wrongly charged to the component. An inline
// `data:` URI (a real, valid 1x1 transparent GIF) resolves with no network
// request at all.
const IMAGE_SRC_PROP_NAME = /^(src|srcset|poster)$/i;

const DATA_URI_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";


// M84: the single place a name-based string heuristic is defined. Both
// `classifyType`'s top-level string branch and `synthesizeValue`'s nested
// object-member branch call this, so a heuristic that works one level deep
// works at every level (commerce's control: top-level `currencyCode`
// synthesizes "USD", nested `label.currencyCode` must synthesize the same
// value, not the generic "test" placeholder it fell back to before this
// milestone). Returns `undefined` when no convention matches, meaning the
// caller falls back to its own generic placeholder.
export function namedStringValue(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (CURRENCY_PROP_NAME.test(name)) return "USD";
  if (LOCALE_PROP_NAME.test(name)) return "en-US";
  if (IMAGE_SRC_PROP_NAME.test(name)) return DATA_URI_PLACEHOLDER;
  return undefined;
}


// M84 cross-lane interface: a boolean whose truthiness imposes a contract on
// another prop (M85's asChild/as/render examples). Deliberately narrow, the
// same allowlist shape as the string heuristics above: these three names are
// the one convention observed across Radix, Base UI, react-aria and shadcn
// corpora. A general "any boolean whose true branch changes what another
// prop must be" detector needs cross-prop analysis this milestone does not
// attempt.
export const CONTRACT_PROP_NAME = /^(asChild|as|render)$/;


// M84: element-plus-F4. An array whose element type could not be resolved
// (commonly an unbound generic, `T[]`) and whose name identifies it as a
// row/item collection gets a real object element instead of the generic
// bare string "item", so a component keying a `WeakMap`/`Map` on its own
// rows (identity, not content) does not throw `TypeError: Invalid value
// used as weak map key`. A dedicated pattern, not `ITEMS_PATTERN` itself:
// it shares that constant's vocabulary plus "rows", but stays separate so
// this fallback can never change `detectScalingProps`'s existing reason
// text or sort priority for an unrelated, already-resolvable array prop.
const IDENTITY_COLLECTION_NAME = /items|options|data|rows|entries|records|elements|list/i;


export function identityCollectionElement(name: string): unknown | undefined {
  return IDENTITY_COLLECTION_NAME.test(name) ? { id: 1 } : undefined;
}
