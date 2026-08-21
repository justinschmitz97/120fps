import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { PropSchema } from "./prop-gen.js";

// A value the entry resolves from the imported preset module at render time.
// Functions and JSX cannot cross the CDP boundary; their position can.
export const PRESET_REF_KEY = "__120fps_preset";

export interface PresetRef {
  [PRESET_REF_KEY]: string;
  index: number;
}

export function isPresetRef(value: unknown): value is PresetRef {
  return typeof value === "object" && value !== null && PRESET_REF_KEY in value;
}

export interface PropPresets {
  // projectRoot-relative posix path, for the report and the fingerprint.
  path: string;
  absolutePath: string;
  // Prop name → the values to measure it with, in declaration order.
  entries: Map<string, unknown[]>;
}

// Mirrors fixture detection: adjacent to the component, named after it.
export function detectPropPresets(componentPath: string): string | undefined {
  const ext = path.extname(componentPath);
  const stem = componentPath.slice(0, -ext.length);
  for (const candidate of [`${stem}.props.tsx`, `${stem}.props.ts`]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Literals are evaluated so they flow through the existing pipeline unchanged:
// combos, deltas, matrix cells and curve anchors all compare real values.
// Everything else keeps its position and is resolved in the page.
// Exported for M57: a Vue `withDefaults` object is the same problem: an AST
// literal that has to become a real value without executing the module.
export function literalValue(node: ts.Expression): { ok: true; value: unknown } | { ok: false } {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { ok: true, value: node.text };
  }
  if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isIdentifier(node) && node.text === "undefined") return { ok: true, value: undefined };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = literalValue(node.operand);
    if (inner.ok && typeof inner.value === "number") return { ok: true, value: -inner.value };
    return { ok: false };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items: unknown[] = [];
    for (const element of node.elements) {
      const item = literalValue(element);
      if (!item.ok) return { ok: false };
      items.push(item.value);
    }
    return { ok: true, value: items };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return { ok: false };
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
      if (key === undefined) return { ok: false };
      const item = literalValue(property.initializer);
      if (!item.ok) return { ok: false };
      object[key] = item.value;
    }
    return { ok: true, value: object };
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return literalValue(node.expression);
  }
  return { ok: false };
}

function findDefaultExport(sf: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expr = statement.expression;
      if (ts.isObjectLiteralExpression(expr)) return expr;
      if (ts.isAsExpression(expr) && ts.isObjectLiteralExpression(expr.expression)) {
        return expr.expression;
      }
      // `export default presets`: follow the binding.
      if (ts.isIdentifier(expr)) {
        for (const candidate of sf.statements) {
          if (!ts.isVariableStatement(candidate)) continue;
          for (const decl of candidate.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || decl.name.text !== expr.text) continue;
            const init = decl.initializer;
            if (init && ts.isObjectLiteralExpression(init)) return init;
            if (init && ts.isAsExpression(init) && ts.isObjectLiteralExpression(init.expression)) {
              return init.expression;
            }
          }
        }
      }
    }
  }
  return undefined;
}

// Parsed, never executed: a preset module imports browser-only code and JSX,
// and running it in Node would be a second, worse module loader.
export function loadPropPresets(presetPath: string, projectRoot: string): PropPresets | undefined {
  const absolutePath = path.resolve(presetPath);
  const text = ts.sys.readFile(absolutePath);
  if (text === undefined) return undefined;

  const sf = ts.createSourceFile(
    absolutePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    absolutePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const object = findDefaultExport(sf);
  if (!object) return undefined;

  const entries = new Map<string, unknown[]>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    if (name === undefined) continue;

    // A bare value is a one-element pool; an array is the pool itself.
    const initializer = property.initializer;
    const expressions = ts.isArrayLiteralExpression(initializer)
      ? [...initializer.elements]
      : [initializer];

    const values = expressions.map((expression, index) => {
      const literal = literalValue(expression);
      return literal.ok ? literal.value : ({ [PRESET_REF_KEY]: name, index } as PresetRef);
    });
    entries.set(name, values);
  }

  return {
    path: path.relative(projectRoot, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    entries,
  };
}

export const UNKNOWN_PRESET_PROPS_WARNING = (presetPath: string, names: string[]): string =>
  `${presetPath} supplies ${names.length === 1 ? "a value" : "values"} for ` +
  `${names.map((n) => `"${n}"`).join(", ")}, which ${names.length === 1 ? "is" : "are"} not ` +
  "a prop of the measured component. Those values were ignored.";

export interface AppliedPresets {
  schemas: PropSchema[];
  // Prop names actually applied, in schema order.
  applied: string[];
  unknown: string[];
}

// M98 (primevue-F1): the kind a preset value implies, for a prop no extraction
// produced a schema for. Values of differing kinds make the pool a union, the
// same word the schema uses for a declared multi-shape prop.
function inferPresetKind(values: unknown[]): PropSchema["kind"] {
  const kinds = new Set<PropSchema["kind"]>();
  for (const value of values) {
    if (isPresetRef(value)) kinds.add("unknown");
    else if (Array.isArray(value)) kinds.add("array");
    else if (value === null || value === undefined) kinds.add("unknown");
    else if (typeof value === "boolean") kinds.add("boolean");
    else if (typeof value === "number") kinds.add("number");
    else if (typeof value === "string") kinds.add("string");
    else if (typeof value === "object") kinds.add("object");
    else kinds.add("unknown");
  }
  if (kinds.size === 0) return "unknown";
  if (kinds.size > 1) return "union";
  return [...kinds][0];
}

// Presets replace a prop's value pool rather than extending it: the point is to
// measure the values the user says are representative, not those plus three
// synthesized ones.
//
// M98 (primevue-F1): the one case where a preset also ADDS. When extraction
// produced nothing -- an Options-API `extends` component, whose own warning
// names `<stem>.props.tsx` as the remedy -- there is no schema to replace, and
// routing every preset key to `unknown` told the user the props they had just
// supplied "are not a prop of the measured component". With extraction
// succeeding, an absent key is still genuinely absent and still reported:
// silently measuring a mistyped key as a prop would drop a disclosure this
// codebase does not drop.
export function applyPropPresets(
  schemas: PropSchema[],
  presets: PropPresets,
): AppliedPresets {
  if (schemas.length === 0) {
    const added: PropSchema[] = [];
    const appliedNames: string[] = [];
    for (const [name, values] of presets.entries) {
      if (values.length === 0) continue;
      appliedNames.push(name);
      added.push({
        name,
        kind: inferPresetKind(values),
        required: false,
        values: [...values],
        provenance: "preset",
      });
    }
    return { schemas: added, applied: appliedNames, unknown: [] };
  }

  const applied: string[] = [];
  const next = schemas.map((schema) => {
    const values = presets.entries.get(schema.name);
    if (values === undefined || values.length === 0) return schema;
    applied.push(schema.name);
    // Whatever synthesis could not build, the preset now supplies: the prop is
    // no longer measured with a stand-in (M60). M84: a preset always wins the
    // provenance question the same way it already wins the value question —
    // this is the only place `provenance: "preset"` is ever assigned.
    const { degenerate: _replaced, ...rest } = schema;
    return { ...rest, values: [...values], provenance: "preset" as const };
  });

  const known = new Set(schemas.map((s) => s.name));
  const unknown = [...presets.entries.keys()].filter((name) => !known.has(name));

  return { schemas: next, applied, unknown };
}
