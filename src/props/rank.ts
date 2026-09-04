import path from "node:path";
import ts from "typescript";
import { isBooleanUnion, nonUndefinedMembers } from "./classify.js";
import { detectPropPresets, loadPropPresets } from "./presets.js";

const NODE_MODULES = /[\\/]node_modules[\\/]/;

const NOISE_PROP_NAME = /^(aria-|data-)/;


// M60: past this the props type is a DOM surface that slipped the filter, not a
// component's own contract.
export const MAX_PROPS = 32;


function isLocalDeclaration(decl: ts.Declaration): boolean {
  return !NODE_MODULES.test(decl.getSourceFile().fileName);
}


// M81: `isNoiseProp` still fully filters ambient (default-lib/@types-react)
// declarations for NESTED object-value synthesis (`synthesizeValue`), where an
// unbounded width would balloon a synthesized object with ~300 DOM/ARIA
// members no one asked for. The top-level prop schema no longer uses it: an
// ambient declaration site does not mean the member is noise (`onClick`,
// `disabled`, `children` are declared there exactly like `aria-activedescendant`
// is), so `typeToSchema` only applies the hard, silent `aria-`/`data-` filter
// and ranks everything else instead of erasing it pre-cap.
export function isNoiseName(name: string): boolean {
  return NOISE_PROP_NAME.test(name);
}


// M81 section 1: a prop named `/^on[A-Z]/` whose type carries a call
// signature (an event handler), or named exactly `children`, is locally
// meaningful regardless of where it is declared.
const EVENT_HANDLER_NAME = /^on[A-Z]/;


// M86: props the cap must never rank away — the target's own source
// referenced them by name, or a `<stem>.props.tsx` preset names them. Both
// are read once per extraction and merged into one promoted-name set;
// `propRank` checks it before any type-shape test.
export function presetPropNames(fileName: string): Set<string> {
  const presetPath = detectPropPresets(fileName);
  if (!presetPath) return new Set();
  const presets = loadPropPresets(presetPath, path.dirname(presetPath));
  return presets ? new Set(presets.entries.keys()) : new Set();
}


// M81 section 1 (M86 adds Tier 0): four-tier rank computed over the props the
// cap has to choose among, stable within each tier.
// Tier 0 - promoted: the target's own source references this name, or a
//          preset names it. Neither signal depends on how the prop's TYPE
//          resolves, so an unresolved generic parameter cannot defeat it.
// Tier 1 - variant surface: a plain boolean or finite literal union on the
//          prop's own type - reuses the same cheap type-flag tests
//          `classifyType` uses later, so it is affordable to run over every
//          kept prop, not just the 32 survivors.
// Tier 2 - locally meaningful: `declaredHere` today, a computed/mapped-type
//          member with zero declarations (there is no declaration site to be
//          third-party at), or an event-handler/`children` name reached only
//          through an ambient declaration.
// Tier 3 - everything else: declared exclusively in node_modules, not
//          variant-shaped - today's tail behavior, unchanged.
// M103 (chakra-ui-F1, heroui-F3, dub-F7): origin decides before shape. M81's
// Tier 1 was shape only, so an inherited `translate?: "yes" | "no"` and an
// inherited `hidden?: boolean` outranked every prop the component itself
// declares whose type resolves to something less tidy -- chakra's Badge
// measured 32 props of which none were Badge's. See M103 in
// specs/overview/02-milestones.md.
export type PropRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;


// M103: how many members the interface or type literal that declares a prop
// declares. A component's own props interface is small (heroui's
// `BadgeRootProps` has six members); a DOM attribute surface
// (`HTMLAttributes`, ~250) and a style system's generated CSS-property surface
// (chakra's `SystemProperties`, ~300) are not. "Declared in the project's own
// sources" alone does not separate chakra's three recipe props from the three
// hundred style props declared beside them in the same package; width does.
const WIDE_DECLARATION_MEMBERS = 40;


// M103 (chakra-F1): the names design systems reserve for their own variant
// axes. Deliberately short and closed -- each one is a name a user varies to
// change how the component looks, and none of them is a DOM attribute.
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

  // M103 (chakra-F1, corpus re-test): a design system declares its own variant
  // surface inside the same generated interface as its three hundred style
  // props, so origin, width and shape cannot separate `colorPalette` from
  // `clipPath`. The name can: these are the names a component library reserves
  // for the axes a user actually varies. Promoted only when the prop carries a
  // string-like type, so a same-named callback or object prop is unaffected.
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

  // Declared in the project's own sources: the component's file, a local type
  // alias, or the package's generated recipe/variant types. A narrow
  // declaration site is the component's own surface; a wide one is a bulk
  // style/attribute surface that happens to live in the same package.
  if (decls && decls.length > 0 && decls.some(isLocalDeclaration)) {
    const narrow = decls.some((d) => isLocalDeclaration(d) && isNarrowDeclarationSite(d));
    if (narrow) return isVariantSurface ? 1 : 2;
    return isVariantSurface ? 4 : 5;
  }

  // A mapped or computed member has no declaration site to be third-party at,
  // and it is exactly the shape `RecipeProps<"badge">`/`VariantProps<typeof x>`
  // produce.
  if (!decls || decls.length === 0) return 3;

  if (isVariantSurface) return 6;

  // M86 mechanism 1: an unresolved generic parameter can make
  // `getCallSignatures()` report zero for a genuinely callable type (a
  // handler prop typed through `IntrinsicElements[E]`-style indirection with
  // `E` unbound). Extensive probing against polymorphic-element and
  // conditional-type shapes did not reproduce a real function type losing its
  // call signatures this way — see `m86-prop-selection-keeps-what-matters.md`
  // `## open` — but the failure signature such a defeat would most plausibly
  // produce (the type resolving to `any`/`unknown` rather than a concrete
  // non-callable type) is cheap and low-risk to also promote: a
  // deliberately-non-function prop named `/^on[A-Z]/` resolves to a concrete
  // type, not `any`/`unknown`.
  const isHandlerOrChildren =
    name === "children" ||
    (EVENT_HANDLER_NAME.test(name) &&
      (nonUndefined.some((t) => t.getCallSignatures().length > 0) ||
        nonUndefined.some((t) => t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))));
  if (isHandlerOrChildren) return 7;

  return 8;
}
