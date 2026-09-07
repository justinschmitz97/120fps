import path from "node:path";
import ts from "typescript";
import { cloneDeep } from "../shared/index.js";
import { isElementOrCallableUnion, isObjectLike, MAX_TUPLE_ARITY, presetRemedyClause } from "./classify.js";
import { emit } from "./extract.js";
import { isNoiseName } from "./rank.js";

// warnDegenerateProps covers synthesis giving up; this covers a value the component cannot use.
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


// A stand-in gives the fields and none of the methods: the shape that crashes on first use.
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


const DEFAULT_LIB_FILE = /[\\/]lib\.[^\\/]*\.d\.ts$/i;

export const REACT_TYPE_PACKAGE = /[\\/]node_modules[\\/](@types[\\/])?react(-dom)?[\\/]/i;


function isDefaultLibFile(fileName: string): boolean {
  return DEFAULT_LIB_FILE.test(fileName);
}


// A property declared elsewhere in node_modules is a design-system prop and is kept.
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

// A props-level object starts one level above an array element: `board.cells[]` is domain data.
export const PROP_SYNTH_MAX_DEPTH = 4;

const SYNTH_MAX_PROPS = 24;


interface SynthContext {
  maxDepth: number;
  // Types on the current path: a recursive type is not re-entered.
  stack: ts.Type[];
  // Members that could not be reproduced faithfully, for the caller's warning.
  notes: string[];
  // Lets the outer object's provenance reflect the riskiest nested value instead of "declared".
  usedHeuristic: boolean;
  usedPlaceholder: boolean;
}


export function newSynth(maxDepth = SYNTH_MAX_DEPTH): SynthContext {
  return { maxDepth, stack: [], notes: [], usedHeuristic: false, usedPlaceholder: false };
}


const MAP_TYPES = new Set(["Map", "WeakMap", "ReadonlyMap"]);

const SET_TYPES = new Set(["Set", "WeakSet", "ReadonlySet"]);

// A real array is a valid `Iterable<T>` and survives the serializer, so it is not degenerate.
const ITERABLE_TYPES = new Set(["Iterable", "IterableIterator"]);

const COLLECTION_ENTRIES = 2;


// A synthetic `__type` symbol names no type and is left to the ordinary object path.
function builtinName(type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  const decls = symbol?.getDeclarations();
  if (!symbol || !decls || decls.length === 0) return undefined;
  const name = symbol.getName();
  if (name.startsWith("__")) return undefined;
  return decls.some((d) => isDefaultLibFile(d.getSourceFile().fileName)) ? name : undefined;
}


// Playwright's serializer has no Map or Set case, so a real instance reaches the page as `{}`.
export function collectionValue(
  type: ts.Type,
  checker: ts.TypeChecker,
): { value: unknown; reason?: string } | undefined {
  const name = builtinName(type);
  if (!name) return undefined;

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
    value: distinctValues(key).map((k) => [k, cloneDeep(value)]),
    reason,
  };
}


// A shape with no distinguishable key collapses to one entry rather than inventing collisions.
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


// A fixed instant, so a component that formats it gets real work; it survives the serializer.
const SYNTH_DATE = "2024-01-01T00:00:00.000Z";


export function instanceValue(type: ts.Type): unknown {
  const name = builtinName(type);
  if (name === "Date") return new Date(SYNTH_DATE);
  if (name === "RegExp") return /120fps/;
  return undefined;
}


// Inventing a field bag for a value whose behaviour is its shape produces a crash.
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
  // A function/element union has no synthesizable field-bag shape.
  if (isElementOrCallableUnion(type, checker)) {
    return `${checker.typeToString(type)} requires a real element or render function`;
  }
  return undefined;
}


// A string element satisfies no object-shaped element type; a sweep reports constant growth.
export function synthesizeElement(arrayType: ts.Type, checker: ts.TypeChecker): unknown {
  const element = checker.getTypeArguments(arrayType as ts.TypeReference)[0];
  if (!element) return undefined;
  return synthesizeValue(element, checker, 0, newSynth());
}


// Passing `name` down keeps namedStringValue's heuristics working at every depth.
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
    // A bounded cycle is still fabricated nesting, so the depth cap alone is not enough.
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


// Narrow by design: Intl construction rejects the generic "test" placeholder.
const CURRENCY_PROP_NAME = /^currency(code)?$/i;

const LOCALE_PROP_NAME = /^(locale|language)$/i;

// A "test" `src` 404s against the harness origin and the 404 is charged to the component.
const IMAGE_SRC_PROP_NAME = /^(src|srcset|poster)$/i;

// An SVG or layout attribute rejects a word, and the element silently falls back to 300x150.
const DIMENSION_PROP_NAME = /^(width|height|size|x|y|r|cx|cy|rx|ry|strokeWidth)$/i;

const DATA_URI_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";


// The one definition of a name-based string heuristic, so it holds at every depth.
export function namedStringValue(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (CURRENCY_PROP_NAME.test(name)) return "USD";
  if (LOCALE_PROP_NAME.test(name)) return "en-US";
  if (IMAGE_SRC_PROP_NAME.test(name)) return DATA_URI_PLACEHOLDER;
  if (DIMENSION_PROP_NAME.test(name)) return "16";
  return undefined;
}


// These names impose a contract on another prop; a general detector needs cross-prop analysis.
export const CONTRACT_PROP_NAME = /^(asChild|as|render)$/;


// A string element throws "Invalid value used as weak map key"; kept apart from ITEMS_PATTERN.
const IDENTITY_COLLECTION_NAME = /items|options|data|rows|entries|records|elements|list/i;


export function identityCollectionElement(name: string): unknown | undefined {
  return IDENTITY_COLLECTION_NAME.test(name) ? { id: 1 } : undefined;
}
