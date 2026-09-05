import path from "node:path";
import ts from "typescript";
import { componentStem, destructuredParameterNames } from "./candidates.js";
import { emit } from "./extract.js";
import { describePresetSibling, detectPropPresets } from "./presets.js";
import { isNoiseName, MAX_PROPS, presetPropNames, propRank, type PropRank } from "./rank.js";
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

// A preset already on disk turns "Add X.props.tsx" into advice to create what the run just read.
export function presetRemedyClause(absolutePath: string): string {
  return detectPropPresets(absolutePath)
    ? ` ${presetFileName(absolutePath)} next to it already supplies the values measured.`
    : ` Add ${presetFileName(absolutePath)} next to it to supply typed values for measurement.`;
}


// A prop the component's source names outranks a purely inherited one; type flow cannot see it.
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


// Names a file the reader can create: a taken `<stem>.props.tsx` shifts to `.120fps.props.tsx`.
export function presetFileName(fileName: string): string {
  const sibling = describePresetSibling(fileName);
  if (sibling?.shape === "preset") return path.basename(sibling.path);
  const stem = componentStem(fileName);
  return sibling ? `${stem}.120fps.props.tsx` : `${stem}.props.tsx`;
}


// Recorded as data so a caller applying a preset afterwards can withhold and re-render the line.
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


// The schema alone hides which branches a collapsed union had, so name every one of them.
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


// Silence here would report timings for renders that never received usable data.
export function warnDegenerateProps(
  fileName: string,
  schemas: PropSchema[],
  sink?: (message: string) => void,
  record?: WarningRecorder,
): void {
  const degenerate = schemas.filter((s) => s.degenerate);
  if (degenerate.length === 0) return;
  // The warning says "supply values yourself"; a user who already did is not told again.
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


// Names the prop: a bare "Maximum call stack size exceeded" reaches the CLI with no attribution.
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


// The same filter classifyTypeByShape applies before its literal-union and boolean tests.
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

  // A dropped required prop is a guaranteed crash, so the cap and ranking apply to optionals only.
  const requiredProps = kept.filter((prop) => !(prop.flags & ts.SymbolFlags.Optional));
  const optionalProps = kept.filter((prop) => !!(prop.flags & ts.SymbolFlags.Optional));

  const promotedNames = new Set([
    ...sourceReferencedPropNames(fn),
    ...(fileName ? presetPropNames(fileName) : []),
  ]);

  // Ranking touches every kept prop, so it needs the same recursion guard as classification below.
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
      // The classification above kept one branch; disclose the rest on the warnings channel.
      const branches = collapsedUnionBranches(propType, checker);
      if (branches && fileName) {
        warnCollapsedUnion(fileName, prop.getName(), branches, schema.kind, sink, record);
      }
      // warnDegenerateProps already covers a required prop synthesis could not fill at all.
      if (
        fileName &&
        schema.required &&
        schema.degenerate === undefined &&
        schema.provenance === "placeholder" &&
        (schema.kind === "object" || schema.kind === "unknown") &&
        // A synthesized object carries data, never behaviour; a plain field bag stays silent.
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


// The contract override is applied once here, so no shape branch has to know about it.
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
  // A nullable literal union is still a literal union, which is what makes VariantProps enumerable.
  const nonUndefinedTypes = nonUndefinedMembers(type);

  const classifyTarget =
    nonUndefinedTypes.length === 1 ? nonUndefinedTypes[0] : type;

  if (isReactNodeMember(type, checker)) {
    return { name, kind: "reactnode", required, values: [], provenance: "placeholder" };
  }

  // `ReactElement | (props) => ReactElement` has no field-bag shape; objectSchema names it opaque.
  if (isElementOrCallableUnion(classifyTarget, checker)) {
    return objectSchema(name, classifyTarget, required, checker);
  }

  if (nonUndefinedTypes.some((t) => t.getCallSignatures().length > 0)) {
    return { name, kind: "function", required, values: [], provenance: "placeholder" };
  }

  if (
    classifyTarget.flags & ts.TypeFlags.BooleanLike ||
    isBooleanUnion(nonUndefinedTypes)
  ) {
    return { name, kind: "boolean", required, values: [true, false], provenance: "declared" };
  }

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

  // `string | number` is two real shapes: one synthesized member per branch exercises both.
  if (isBarePrimitiveUnion(nonUndefinedTypes)) {
    const values = nonUndefinedTypes.map((member) =>
      member.flags & ts.TypeFlags.String ? (namedStringValue(name) ?? "test") : 1,
    );
    return { name, kind: "union", required, values, provenance: "placeholder" };
  }

  // A runtime validator rejects the generic placeholder, so namedStringValue keys off the name.
  if (classifyTarget.flags & ts.TypeFlags.String) {
    const named = namedStringValue(name);
    if (named !== undefined) {
      return { name, kind: "string", required, values: [named], provenance: "heuristic" };
    }
    return { name, kind: "string", required, values: ["test"], provenance: "placeholder" };
  }

  if (classifyTarget.flags & ts.TypeFlags.Number) {
    return { name, kind: "number", required, values: [1, 5, 20], provenance: "placeholder" };
  }

  // Tuple: fixed arity, so it is neither an open array nor a bag of fields.
  if (checker.isTupleType(classifyTarget)) {
    return tupleSchema(name, classifyTarget, required, checker);
  }

  // An unresolvable element type falls back to a real object when the name reads as a collection.
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

  // A union stands in for its first member, the way an array element type does.
  if (isObjectLike(classifyTarget)) {
    return objectSchema(name, classifyTarget, required, checker);
  }
  if (nonUndefinedTypes.length > 1 && nonUndefinedTypes.every(isObjectLike)) {
    return objectSchema(name, nonUndefinedTypes[0], required, checker);
  }

  // A primitive-plus-literal union (`number | 'any'`) picks the literal over falling to unknown.
  const hasLiteralMember = nonUndefinedTypes.some(
    (m) => m.isStringLiteral() || m.isNumberLiteral() || !!(m.flags & ts.TypeFlags.BooleanLiteral),
  );
  // A lone literal member ("solo"|undefined) reports its primitive kind; "union" implies choice.
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


// `A & B` carries members like `interface C extends A, B`, but flags as Intersection.
export function isObjectLike(type: ts.Type): boolean {
  return !!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection));
}


// A tuple's arity is part of its type: three items in `[string, string]` is as wrong as none.
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
    // Provenance takes the riskiest nested field: heuristic beats placeholder beats declared.
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


// Shared with opaqueReason so the routing and the degenerate reason agree on the shape.
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


// Bare primitives only: a literal member routes to the literal-union branches instead.
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


// Undefined when the union is self-explanatory or warnDegenerateProps already discloses it.
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
  // `string | number` collapses to one member per branch, so it gets the same disclosure.
  if (isBarePrimitiveUnion(nonUndefined)) return nonUndefined.map((m) => checker.typeToString(m));
  // Nothing collapsed when no literal was there to pick, so there is no branch list to disclose.
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


// A placeholder string satisfies ReactNode; ReactElement fails callers' React.isValidElement().
function isReactNodeMember(type: ts.Type, checker: ts.TypeChecker): boolean {
  // The whole type: TS prints the ReactNode alias only for a direct reference, never per member.
  return /^(React\.)?ReactNode$/.test(checker.typeToString(type));
}
