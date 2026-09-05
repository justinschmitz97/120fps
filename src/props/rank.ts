import path from "node:path";
import ts from "typescript";
import { isBooleanUnion, nonUndefinedMembers } from "./classify.js";
import { detectPropPresets, loadPropPresets } from "./presets.js";

const NODE_MODULES = /[\\/]node_modules[\\/]/;

const NOISE_PROP_NAME = /^(aria-|data-)/;


// Past this the props type is a DOM surface that slipped the filter.
export const MAX_PROPS = 32;


function isLocalDeclaration(decl: ts.Declaration): boolean {
  return !NODE_MODULES.test(decl.getSourceFile().fileName);
}


// An ambient declaration site does not make a member noise; typeToSchema ranks instead of erasing.
export function isNoiseName(name: string): boolean {
  return NOISE_PROP_NAME.test(name);
}


// An event handler is locally meaningful wherever it is declared.
const EVENT_HANDLER_NAME = /^on[A-Z]/;


// Names the cap must never rank away; propRank checks them before any type-shape test.
export function presetPropNames(fileName: string): Set<string> {
  const presetPath = detectPropPresets(fileName);
  if (!presetPath) return new Set();
  const presets = loadPropPresets(presetPath, path.dirname(presetPath));
  return presets ? new Set(presets.entries.keys()) : new Set();
}


// Origin decides before shape: an inherited tidy type must not outrank the component's own prop.
export type PropRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;


// Origin cannot separate own props from a style surface in one package; ~6 members vs 250+ can.
const WIDE_DECLARATION_MEMBERS = 40;


// Closed by design: each name is a variant axis a user varies, and none is a DOM attribute.
const KNOWN_VARIANT_AXIS_NAMES = new Set([
  "colorPalette",
  "colorScheme",
  "variant",
  "size",
  "tone",
  "intent",
  "appearance",
  "severity",
  "status",
]);


function isNarrowDeclarationSite(decl: ts.Declaration): boolean {
  const parent = decl.parent;
  if (!parent) return true;
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) {
    return parent.members.length < WIDE_DECLARATION_MEMBERS;
  }
  if (ts.isTypeLiteralNode(parent)) return parent.members.length < WIDE_DECLARATION_MEMBERS;
  return true;
}


export function propRank(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
  promotedNames: Set<string>,
): PropRank {
  const name = prop.getName();
  if (promotedNames.has(name)) return 0;

  const decls = prop.getDeclarations();
  const decl = decls?.[0];
  const type = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getTypeOfSymbol(prop);
  const nonUndefined = nonUndefinedMembers(type);
  const target = nonUndefined.length === 1 ? nonUndefined[0] : type;

  // The name promotes only a string-like prop, so a same-named callback or object is unaffected.
  const isStringLike = nonUndefined.some(
    (member) =>
      !!(member.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) ||
      member.isStringLiteral(),
  );

  const isVariantSurface =
    !!(target.flags & ts.TypeFlags.BooleanLike) ||
    isBooleanUnion(nonUndefined) ||
    (nonUndefined.length > 1 &&
      nonUndefined.every((m) => m.isStringLiteral() || !!(m.flags & ts.TypeFlags.StringLiteral))) ||
    (nonUndefined.length > 1 &&
      nonUndefined.every((m) => m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.NumberLiteral)));

  if (KNOWN_VARIANT_AXIS_NAMES.has(name) && (isVariantSurface || isStringLike)) {
    return isVariantSurface ? 1 : 2;
  }

  // A narrow local declaration site is the component's own surface; a wide one is bulk style.
  if (decls && decls.length > 0 && decls.some(isLocalDeclaration)) {
    const narrow = decls.some((d) => isLocalDeclaration(d) && isNarrowDeclarationSite(d));
    if (narrow) return isVariantSurface ? 1 : 2;
    return isVariantSurface ? 4 : 5;
  }

  // A mapped or computed member has no declaration site to be third-party at.
  if (!decls || decls.length === 0) return 3;

  if (isVariantSurface) return 6;

  // `any`/`unknown` counts: an unbound generic can hide a handler's call signatures.
  const isHandlerOrChildren =
    name === "children" ||
    (EVENT_HANDLER_NAME.test(name) &&
      (nonUndefined.some((t) => t.getCallSignatures().length > 0) ||
        nonUndefined.some((t) => t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))));
  if (isHandlerOrChildren) return 7;

  return 8;
}
