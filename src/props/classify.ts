import path from "node:path";
import ts from "typescript";
import { componentStem, destructuredParameterNames } from "./candidates.js";
import { emit } from "./extract.js";
import { describePresetSibling, detectPropPresets } from "./presets.js";
import { isNoiseName, MAX_PROPS, presetPropNames, propRank, type PropRank } from "./program.js";
import type { PropSchema, PropWarningRecord, WarningRecorder } from "./schema.js";
import {
  collectionValue,
  CONTRACT_PROP_NAME,
  hasMethodMembers,
  identityCollectionElement,
  instanceValue,
  namedStringValue,
  newSynth,
  opaqueReason,
  PROP_SYNTH_MAX_DEPTH,
  synthesizeElement,
  synthesizeValue,
  warnSynthesizedRequiredObject,
} from "./synthesize.js";

// M98 (primevue-F1): the remedy half of every scope-exclusion warning. With
// the preset file already on disk, "Add Badge.props.tsx" told a user to create
// what the same run had just loaded and measured.
export function presetRemedyClause(absolutePath: string): string {
  return detectPropPresets(absolutePath)
    ? ` ${presetFileName(absolutePath)} next to it already supplies the values measured.`
    : ` Add ${presetFileName(absolutePath)} next to it to supply typed values for measurement.`;
}


// M86 MUST 1: a prop the component's own source references by name outranks
// an inherited prop it does not — a source-TEXT signal, not a type-flow one.
// ant-design's Button calls `props.onClick?.(...)` (Button.tsx:294) and wires
// `onClick={handleClick}` while `onClick`'s type is purely inherited through
// `MergedHTMLAttributes` with no local redeclaration; M81's tiers only ever
// look at where a prop's TYPE is declared, so they cannot see this. Walks the
// bound function's own body once for `<param>.name` member access and any
// local `const { name } = <param>` destructuring, in addition to the
// destructured-parameter names `destructuredParameterNames` already finds.
function sourceReferencedPropNames(fn: ts.SignatureDeclaration | undefined): Set<string> {
  const names = new Set(destructuredParameterNames(fn));
  const param = fn?.parameters[0];
  const body = fn && "body" in fn ? fn.body : undefined;
  if (!param || !body || !ts.isIdentifier(param.name)) return names;
  const paramName = param.name.text;

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === paramName
    ) {
      names.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === paramName
    ) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken) continue;
        const source = element.propertyName ?? element.name;
        if (ts.isIdentifier(source) || ts.isStringLiteral(source)) names.add(source.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}


// The M44 escape hatch, named for the file at hand so the message is a command.
// M112 B2: the older name belongs to whatever already sits on disk under it, so
// a remedy that would otherwise name a file the reader cannot create names the
// preferred `<stem>.120fps.props.tsx` instead.
export function presetFileName(fileName: string): string {
  const sibling = describePresetSibling(fileName);
  if (sibling?.shape === "preset") return path.basename(sibling.path);
  const stem = componentStem(fileName);
  return sibling ? `${stem}.120fps.props.tsx` : `${stem}.props.tsx`;
}


// M112 B3 (logto-F4): the sink carries this warning the way it already carries
// the collapsed-union and degenerate ones, so a caller that applies a preset
// afterwards can withhold the line and re-render it from the record.
function warnPropCap(
  fileName: string,
  total: number,
  sink?: (message: string) => void,
  record?: WarningRecorder,
): void {
  const text =
    `Warning: ${total} props were extracted from ${fileName}; measuring the first ${MAX_PROPS}. ` +
    `Add ${presetFileName(fileName)} to choose the props that matter.\n`;
  record?.({ kind: "prop-cap", stem: componentStem(fileName), text: text.trimEnd() });
  emit(`${path.resolve(fileName)}::cap`, text, sink);
}


// M84: a union with more than one non-undefined member collapses to one
// representative kind/value; a user reading only the schema cannot see what
// the other branches were. Names every branch's printed type and which kind
// the prop was measured as.
function warnCollapsedUnion(
  fileName: string,
  propName: string,
  branches: string[],
  chosenKind: string,
  sink?: (message: string) => void,
  record?: WarningRecorder,
): void {
  const text =
    `Warning: prop "${propName}" in ${fileName} is a union of ${branches.length} different shapes ` +
    `(${branches.join(" | ")}); measured as ${chosenKind}. Add ${presetFileName(fileName)} to choose ` +
    `a different branch.\n`;
  record?.({ kind: "collapsed-union", stem: componentStem(fileName), text: text.trimEnd() });
  emit(`${path.resolve(fileName)}::union::${propName}`, text, sink);
}


// M60: the props the component is measured with are not the props it declares.
// Silence here is what let four dogfooded projects report timings for renders
// that never received usable data.
export function warnDegenerateProps(
  fileName: string,
  schemas: PropSchema[],
  sink?: (message: string) => void,
  record?: WarningRecorder,
): void {
  const degenerate = schemas.filter((s) => s.degenerate);
  if (degenerate.length === 0) return;
  // The warning's whole content is "supply values yourself". A user who already
  // has is not told again.
  if (detectPropPresets(fileName)) return;
  const named = degenerate.map((s) => `${s.name} (${s.degenerate})`).join(", ");
  const text =
    `Warning: no representative value could be synthesized for ${named} in ${fileName}. ` +
    `Add ${presetFileName(fileName)} next to it to supply real values.\n`;
  record?.({ kind: "degenerate", stem: componentStem(fileName), text: text.trimEnd() });
  emit(
    `${path.resolve(fileName)}::degenerate::${degenerate.map((s) => s.name).join(",")}`,
    text,
    sink,
  );
}


// M81 section 6: a self-referential generic member can make a single checker
// call recurse arbitrarily deep inside TypeScript's own instantiation
// machinery. Named and excluded, the same register as an unenumerable
// computed type, instead of a bare "Maximum call stack size exceeded"
// reaching the CLI's top-level handler with no attribution.
function warnRecursiveProp(
  fileName: string,
  propName: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::recursive::${propName}`,
    `Warning: prop "${propName}" in ${fileName} could not be classified: TypeScript's type resolution ` +
      `recursed too deeply -- likely a self-referential generic type. Excluded from the schema.\n`,
    sink,
  );
}


export function warnRecursiveType(
  fileName: string,
  targetName: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::recursive-type::${targetName}`,
    `Warning: props could not be resolved for ${targetName} in ${fileName}: TypeScript's type resolution ` +
      `recursed too deeply -- likely a self-referential generic type.\n`,
    sink,
  );
}


// Non-`undefined`/`null`/`void` members of a (possibly union) type: the same
// filter `classifyType` applies before its own literal-union/boolean tests.
export function nonUndefinedMembers(type: ts.Type): ts.Type[] {
  return type.isUnion()
    ? type.types.filter(
        (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
      )
    : [type];
}


export function typeToSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  fileName?: string,
  sink?: (message: string) => void,
  fn?: ts.SignatureDeclaration,
  record?: WarningRecorder,
): PropSchema[] {
  const kept = type.getProperties().filter((prop) => !isNoiseName(prop.getName()));

  // M86: required props are never dropped by the cap — a missing required
  // prop is not a degraded test case, it is a guaranteed crash (shadcn's
  // `chart.tsx` loses its required `config: ChartConfig` this way today).
  // They bypass ranking entirely; only the optional pool is ranked and
  // capped to whatever budget remains.
  const requiredProps = kept.filter((prop) => !(prop.flags & ts.SymbolFlags.Optional));
  const optionalProps = kept.filter((prop) => !!(prop.flags & ts.SymbolFlags.Optional));

  const promotedNames = new Set([
    ...sourceReferencedPropNames(fn),
    ...(fileName ? presetPropNames(fileName) : []),
  ]);

  // A single checker call (`getTypeOfSymbolAtLocation`) can recurse arbitrarily
  // deep inside TypeScript's own instantiation machinery for a self-referential
  // generic member (M81 section 6); ranking runs this over every kept prop, not
  // just the 32 survivors, so it needs the same guard as classification below.
  const ranked: { prop: ts.Symbol; rank: PropRank }[] = [];
  for (const prop of optionalProps) {
    try {
      ranked.push({ prop, rank: propRank(prop, checker, promotedNames) });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (fileName) warnRecursiveProp(fileName, prop.getName(), sink);
    }
  }
  const orderedOptional = ranked
    .map((r, index) => ({ ...r, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.prop);

  const totalKept = requiredProps.length + orderedOptional.length;
  if (totalKept > MAX_PROPS && fileName) {
    warnPropCap(fileName, totalKept, sink, record);
  }

  const optionalBudget = Math.max(0, MAX_PROPS - requiredProps.length);
  const ordered = [...requiredProps, ...orderedOptional.slice(0, optionalBudget)];

  const schemas: PropSchema[] = [];
  for (const prop of ordered) {
    try {
      const decl = prop.getDeclarations()?.[0];
      const propType = decl
        ? checker.getTypeOfSymbolAtLocation(prop, decl)
        : checker.getTypeOfSymbol(prop);
      const required = !(prop.flags & ts.SymbolFlags.Optional);

      const schema = classifyType(prop.getName(), propType, required, checker);
      schemas.push(schema);
      // M84: a genuine multi-branch union (mixed primitive+literal, or
      // structurally different shapes like `string | ReactElement`) collapses
      // to one representative value/kind above; disclose every branch it had
      // and which one won, on the same warnings channel every other
      // extraction warning uses.
      const branches = collapsedUnionBranches(propType, checker);
      if (branches && fileName) {
        warnCollapsedUnion(fileName, prop.getName(), branches, schema.kind, sink, record);
      }
      // M103 (dub-F2): a required prop the synthesizer could only fill with a
      // stand-in object. `warnDegenerateProps` already covers the case where it
      // produced nothing at all.
      if (
        fileName &&
        schema.required &&
        schema.degenerate === undefined &&
        schema.provenance === "placeholder" &&
        (schema.kind === "object" || schema.kind === "unknown") &&
        // The discriminator: a plain synthesized object can carry data, never
        // behaviour. dub's `TableType` declares `getVisibleLeafColumns()` and
        // `getRowModel()`; a domain object of plain fields synthesizes fine and
        // stays silent.
        hasMethodMembers(propType)
      ) {
        warnSynthesizedRequiredObject(
          fileName,
          prop.getName(),
          checker.typeToString(propType),
          sink,
        );
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (fileName) warnRecursiveProp(fileName, prop.getName(), sink);
    }
  }

  return schemas;
}


// M84: a boolean whose name is a known contract convention (`asChild`, `as`,
// `render`) always reports provenance:"contract", regardless of which kind
// branch below actually classified it (boolean, function, a degenerate
// object via `isElementOrCallableUnion`, or a string-literal union for a
// polymorphic `as`). Applied once, at the end, so no individual branch needs
// to know about the override.
function classifyType(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  const schema = classifyTypeByShape(name, type, required, checker);
  if (CONTRACT_PROP_NAME.test(name)) {
    return { ...schema, provenance: "contract" };
  }
  return schema;
}


function classifyTypeByShape(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  // Absent members carry no shape. `null` and `void` are stripped next to
  // `undefined` because a nullable literal union is still a literal union:
  // that is what makes cva's `VariantProps<typeof x>` enumerable.
  const nonUndefinedTypes = nonUndefinedMembers(type);

  // If only one non-undefined type, classify it directly
  const classifyTarget =
    nonUndefinedTypes.length === 1 ? nonUndefinedTypes[0] : type;

  // ReactNode: only a member that IS ReactNode, or one provably assignable
  // from `string` (which ReactNode structurally is and ReactElement is not).
  // A `ReactElement | JSX.Element` member alone no longer qualifies (M81 3b):
  // a plain `ReactNode` renders a placeholder string fine; `ReactElement` does
  // not, because callers run `React.isValidElement()` on it.
  if (isReactNodeMember(type, checker)) {
    return { name, kind: "reactnode", required, values: [], provenance: "placeholder" };
  }

  // M81 3b: `ReactElement | (props) => ReactElement` (Base UI's `render`, and
  // the same "universal customization prop" idiom in other headless
  // libraries) is neither a plain function prop nor a ReactNode: it has no
  // synthesizable field-bag shape either, so it is routed to objectSchema's
  // existing opaque path instead of being classified as `function` below.
  if (isElementOrCallableUnion(classifyTarget, checker)) {
    return objectSchema(name, classifyTarget, required, checker);
  }

  // Function/callback: check all non-undefined members
  if (nonUndefinedTypes.some((t) => t.getCallSignatures().length > 0)) {
    return { name, kind: "function", required, values: [], provenance: "placeholder" };
  }

  // Boolean: either BooleanLike flag or union of true|false literals
  if (
    classifyTarget.flags & ts.TypeFlags.BooleanLike ||
    isBooleanUnion(nonUndefinedTypes)
  ) {
    return { name, kind: "boolean", required, values: [true, false], provenance: "declared" };
  }

  // String literal union
  if (
    nonUndefinedTypes.length > 1 &&
    nonUndefinedTypes.every(
      (m) => m.isStringLiteral() || m.flags & ts.TypeFlags.StringLiteral,
    )
  ) {
    const values = nonUndefinedTypes.map((m) => {
      if (m.isStringLiteral()) return m.value;
      return checker.typeToString(m).replace(/^"(.*)"$/, "$1");
    });
    return { name, kind: "union", required, values, provenance: "declared" };
  }

  // Number literal union
  if (
    nonUndefinedTypes.length > 1 &&
    nonUndefinedTypes.every(
      (m) => m.isNumberLiteral() || m.flags & ts.TypeFlags.NumberLiteral,
    )
  ) {
    const values = nonUndefinedTypes.map((m) => {
      if (m.isNumberLiteral()) return m.value;
      return Number(checker.typeToString(m));
    });
    return { name, kind: "union", required, values, provenance: "declared" };
  }

  // M98 (element-plus-F3): `string | number` is a genuine union of two
  // primitive shapes -- element-plus declares `value`, `width`, `height` and
  // `maxHeight` that way. It matched no branch above and fell through to the
  // opaque path, printing `unknown` with no disclosure while every other
  // multi-shape prop in the same run got one. One synthesized member per
  // branch, so the pool actually exercises both.
  if (isBarePrimitiveUnion(nonUndefinedTypes)) {
    const values = nonUndefinedTypes.map((member) =>
      member.flags & ts.TypeFlags.String ? (namedStringValue(name) ?? "test") : 1,
    );
    return { name, kind: "union", required, values, provenance: "placeholder" };
  }

  // Plain string. M81 3d: `classifyType` has no way to see that a runtime
  // validator (`Intl.NumberFormat`'s `currency` option, a BCP 47 locale tag)
  // will reject the generic placeholder; `namedStringValue` (M84: the single
  // shared definition with `synthesizeValue`'s nested branch) closes the
  // repeatedly-observed false-FAIL classes without claiming every
  // runtime-validated string is now safe.
  if (classifyTarget.flags & ts.TypeFlags.String) {
    const named = namedStringValue(name);
    if (named !== undefined) {
      return { name, kind: "string", required, values: [named], provenance: "heuristic" };
    }
    return { name, kind: "string", required, values: ["test"], provenance: "placeholder" };
  }

  // Plain number
  if (classifyTarget.flags & ts.TypeFlags.Number) {
    return { name, kind: "number", required, values: [1, 5, 20], provenance: "placeholder" };
  }

  // Tuple: fixed arity, so it is neither an open array nor a bag of fields.
  if (checker.isTupleType(classifyTarget)) {
    return tupleSchema(name, classifyTarget, required, checker);
  }

  // Array. M84: when the element type cannot be resolved (commonly an
  // unbound generic) and the name identifies an identity-keyed collection
  // (rows/items a component may key a WeakMap on), the fallback element is a
  // real object, not the generic bare string "item" — see
  // `identityCollectionElement`.
  if (checker.isArrayType(classifyTarget)) {
    const elementTemplate = synthesizeElement(classifyTarget, checker);
    if (elementTemplate !== undefined) {
      return {
        name,
        kind: "array",
        required,
        values: [[], [elementTemplate]],
        elementTemplate,
        provenance: "declared",
      };
    }
    const identityElement = identityCollectionElement(name);
    if (identityElement !== undefined) {
      return {
        name,
        kind: "array",
        required,
        values: [[], [identityElement]],
        elementTemplate: identityElement,
        provenance: "heuristic",
      };
    }
    return {
      name,
      kind: "array",
      required,
      values: [[], ["item"]],
      provenance: "placeholder",
    };
  }

  // Object: one shape, an intersection of them, or a union. A union stands in
  // for its first member, exactly as an array element type does.
  if (isObjectLike(classifyTarget)) {
    return objectSchema(name, classifyTarget, required, checker);
  }
  if (nonUndefinedTypes.length > 1 && nonUndefinedTypes.every(isObjectLike)) {
    return objectSchema(name, nonUndefinedTypes[0], required, checker);
  }

  // M84: a union mixing a primitive type with a literal member (`boolean |
  // 'trap-focus'`, `number | 'any'`) matches none of the pure-kind checks
  // above (not a pure literal union, not boolean-only, not reactnode,
  // element-or-callable, function, or object-like). Pick the first member
  // with a synthesizable primitive kind — a literal preferred over a bare
  // boolean/string/number, since a literal is the more informative sample —
  // so the schema carries a real value instead of falling to "unknown" with
  // an empty value and no disclosure (base-ui's `modal?: boolean |
  // 'trap-focus'` and `step?: number | 'any'`, both silently dropped today).
  // The value comes directly from a real member of the declared type, so
  // provenance is "declared" like any other union-member pick. Gated on at
  // least one member actually being a literal: a union of two bare primitive
  // types with no literal anywhere (`string | number`) has no finite,
  // meaningfully-preferred member to pick over any other — that shape stays
  // the pre-existing "unknown"/degenerate behavior below, unchanged.
  const hasLiteralMember = nonUndefinedTypes.some(
    (m) => m.isStringLiteral() || m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.BooleanLiteral),
  );
  // A single non-undefined member that IS a literal (an optional prop typed
  // exactly `"solo" | undefined`, which strips to one member) reaches here
  // too — the pure-literal-union checks above require 2+ members, and a
  // literal's own flags never overlap the generic String/Number flags the
  // plain-string/-number checks test — so it is a real, if lone, union
  // member the same way a 2+ member literal union is: reported by its own
  // primitive kind rather than the "union" framing multiple choices imply.
  if (nonUndefinedTypes.length >= 1 && hasLiteralMember) {
    for (const member of nonUndefinedTypes) {
      if (member.isStringLiteral()) {
        const kind = nonUndefinedTypes.length === 1 ? "string" : "union";
        return { name, kind, required, values: [member.value], provenance: "declared" };
      }
      if (member.isNumberLiteral()) {
        const kind = nonUndefinedTypes.length === 1 ? "number" : "union";
        return { name, kind, required, values: [member.value], provenance: "declared" };
      }
    }
    for (const member of nonUndefinedTypes) {
      if (member.flags & ts.TypeFlags.BooleanLike) {
        return { name, kind: "boolean", required, values: [true, false], provenance: "declared" };
      }
      if (member.flags & ts.TypeFlags.String) {
        const named = namedStringValue(name);
        return {
          name,
          kind: "string",
          required,
          values: [named ?? "test"],
          provenance: named !== undefined ? "heuristic" : "declared",
        };
      }
      if (member.flags & ts.TypeFlags.Number) {
        return { name, kind: "number", required, values: [1], provenance: "declared" };
      }
    }
  }

  return {
    name,
    kind: "unknown",
    required,
    values: [],
    provenance: "placeholder",
    ...(required
      ? { degenerate: `no value can be enumerated from ${checker.typeToString(type)}` }
      : {}),
  };
}


// `A & B` carries members exactly as `interface C extends A, B` does, but its
// type flag is Intersection rather than Object.
export function isObjectLike(type: ts.Type): boolean {
  return !!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection));
}


// A tuple's arity is part of its type: `[string, string]` filled with three
// items is as wrong as filling it with none.
export const MAX_TUPLE_ARITY = 8;


function tupleSchema(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  const positions = checker
    .getTypeArguments(type as ts.TypeReference)
    .slice(0, MAX_TUPLE_ARITY);
  const value = positions.map((position) => synthesizeValue(position, checker, 0, newSynth()));
  const missing = positions.length === 0 || value.some((v) => v === undefined);
  return {
    name,
    kind: "object",
    required,
    values: [value],
    provenance: "declared",
    ...(missing ? { degenerate: `tuple positions of ${checker.typeToString(type)}` } : {}),
  };
}


function objectSchema(
  name: string,
  type: ts.Type,
  required: boolean,
  checker: ts.TypeChecker,
): PropSchema {
  const collection = collectionValue(type, checker);
  if (collection) {
    return {
      name,
      kind: "object",
      required,
      values: [collection.value],
      provenance: "declared",
      ...(collection.reason ? { degenerate: collection.reason } : {}),
    };
  }

  const instance = instanceValue(type);
  if (instance !== undefined) {
    return { name, kind: "object", required, values: [instance], provenance: "declared" };
  }

  const opaque = opaqueReason(type, checker);
  if (opaque) {
    return { name, kind: "object", required, values: [{}], degenerate: opaque, provenance: "placeholder" };
  }

  const synth = newSynth(PROP_SYNTH_MAX_DEPTH);
  const shaped = synthesizeValue(type, checker, 0, synth);
  if (isShapedObject(shaped)) {
    // A member the browser cannot receive makes the whole object a stand-in,
    // however well the rest of it synthesized. M84: the outer object's
    // provenance takes the riskiest thing any nested field used — heuristic
    // beats placeholder beats declared — so a consumer deciding whether a
    // crash traces to a harness-supplied value (M85) can read one field on
    // this prop instead of walking the synthesized object itself.
    const provenance = synth.usedHeuristic ? "heuristic" : synth.usedPlaceholder ? "placeholder" : "declared";
    return {
      name,
      kind: "object",
      required,
      values: [shaped],
      provenance,
      ...(synth.notes.length > 0 ? { degenerate: [...new Set(synth.notes)].join("; ") } : {}),
    };
  }

  return {
    name,
    kind: "object",
    required,
    values: [{}],
    degenerate: `no synthesizable members on ${checker.typeToString(type)}`,
    provenance: "placeholder",
  };
}


function isShapedObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.some(([, v]) => v !== undefined);
}


// M81 3b: a union carrying both a React-element-shaped member and a callable
// member, with no primitive/ReactNode member to fall back to. `classifyType`
// uses this to route the shape to `objectSchema` instead of `"function"`;
// `opaqueReason` uses the same test to name it degenerate once there.
export function isElementOrCallableUnion(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (!type.isUnion()) return false;
  const members = nonUndefinedMembers(type);
  const hasElement = members.some((t) => /ReactElement|JSX\.Element/.test(checker.typeToString(t)));
  const hasCallable = members.some((t) => t.getCallSignatures().length > 0);
  const hasPrimitive = members.some(
    (t) => t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike),
  );
  return hasElement && hasCallable && !hasPrimitive;
}


// M84: every printed branch of a union `classifyType` collapsed to one
// representative kind/value, or `undefined` when the union is a case that is
// already fully self-explanatory (a pure string- or number-literal union, a
// boolean union, a plain `ReactNode`) or already disclosed by M81's own
// `degenerate` warning (an element-or-callable union routes through
// `opaqueReason`, which `warnDegenerateProps` already names).
// M98 (element-plus-F3): exactly `string | number` / `number | string`. Bare
// primitives only -- a literal member routes to the literal-union branches, and
// every other mixed shape keeps the behavior it had.
function isBarePrimitiveUnion(members: ts.Type[]): boolean {
  if (members.length < 2) return false;
  const isBare = (member: ts.Type): boolean =>
    !!(member.flags & (ts.TypeFlags.String | ts.TypeFlags.Number)) &&
    !member.isStringLiteral() &&
    !member.isNumberLiteral();
  return (
    members.every(isBare) &&
    members.some((m) => !!(m.flags & ts.TypeFlags.String)) &&
    members.some((m) => !!(m.flags & ts.TypeFlags.Number))
  );
}


function collapsedUnionBranches(type: ts.Type, checker: ts.TypeChecker): string[] | undefined {
  const nonUndefined = nonUndefinedMembers(type);
  if (nonUndefined.length <= 1) return undefined;
  if (isReactNodeMember(type, checker)) return undefined;
  const classifyTarget = nonUndefined.length === 1 ? nonUndefined[0] : type;
  if (isElementOrCallableUnion(classifyTarget, checker)) return undefined;
  if (isBooleanUnion(nonUndefined)) return undefined;
  if (nonUndefined.every((m) => m.isStringLiteral() || !!(m.flags & ts.TypeFlags.StringLiteral))) {
    return undefined;
  }
  if (nonUndefined.every((m) => m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.NumberLiteral))) {
    return undefined;
  }
  // M98: `string | number` now collapses to one representative member per
  // branch, so it gets the disclosure every other union gets. Before M98 it
  // stayed an opaque `unknown` and there was no collapse to describe.
  if (isBarePrimitiveUnion(nonUndefined)) return nonUndefined.map((m) => checker.typeToString(m));
  // A union of bare primitive types with no literal member anywhere has
  // nothing classifyType actually collapsed: the mixed-union fallback above
  // requires a literal to pick from and leaves this shape as the pre-existing
  // "unknown"/degenerate value, unchanged by M84. Disclosing "branches" for a
  // value that stayed empty would describe a collapse that never happened.
  const hasObjectMember = nonUndefined.some(isObjectLike);
  const hasLiteralMember = nonUndefined.some(
    (m) => m.isStringLiteral() || m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.BooleanLiteral),
  );
  if (!hasObjectMember && !hasLiteralMember) return undefined;
  return nonUndefined.map((m) => checker.typeToString(m));
}


export function isBooleanUnion(types: ts.Type[]): boolean {
  return (
    types.length === 2 &&
    types.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)
  );
}


// M81 3b: narrower than a bare `ReactElement|JSX\.Element` text match. A
// plain `ReactNode` renders a placeholder string fine (it structurally
// includes `string`); a bare `ReactElement` does not, because callers run
// `React.isValidElement()` on it, which a string fails.
function isReactNodeMember(type: ts.Type, checker: ts.TypeChecker): boolean {
  // Checked against the WHOLE declared type, before it is decomposed into
  // individual union members: TS preserves the `ReactNode` alias name when
  // printing a direct reference to it, but `ReactNode`'s own definition is
  // itself a union (string | number | ReactElement | Iterable<ReactNode> |
  // ...), so none of ITS decomposed members individually prints "ReactNode" -
  // checking per-member (as the milestone's own literal wording suggests)
  // would never match the common case and was verified empirically to fail.
  // An "assignable from string" fallback was tried and rejected: a plain
  // `string` prop, and any `Iterable<string>`-shaped prop, are both trivially
  // string-assignable and would be misclassified as reactnode too.
  return /^(React\.)?ReactNode$/.test(checker.typeToString(type));
}
