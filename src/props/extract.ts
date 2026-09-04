import path from "node:path";
import ts from "typescript";
import { isVueFile } from "../project/index.js";
import {
  applyDeclaredDefaults,
  defaultPropsAssignment,
  destructuredParameterDefaults,
  findComponentPropsType,
  type PropsBinding,
  propsFromDeclaration,
  resolveEntryDeclaration,
} from "./candidates.js";
import { presetFileName, typeToSchema, warnDegenerateProps, warnRecursiveType } from "./classify.js";
import { detectPropPresets } from "./presets.js";
import { createCachedProgram, createCompilerOptions } from "./program.js";
import type { PropSchema, PropWarningRecord, ScalingPropMatch, WarningRecorder } from "./schema.js";
import { extractVueProps } from "./vue.js";

// M65: `target` overrides M58's selection order with the export the user named
// (`<file>#Export`); `onWarning` collects what extraction would have written to
// stderr, so a dry run can print the same diagnostics as data.
export interface ExtractPropsOptions {
  target?: string;
  onWarning?: (message: string) => void;
}


export interface PropsExtraction {
  schemas: PropSchema[];
  // The declaration the schema was bound to, and where it sits. Absent for a
  // Vue SFC, whose props come from a `defineProps` call rather than a component
  // declaration, and for a file with no component at all.
  targetName?: string;
  targetLine?: number;
  computedAnnotation?: string;
  // M114 B4 (gutenberg-F2): the module the binding was read from, when the
  // measured file only re-exports the component another module declares.
  // Absent when the component is declared in the measured file itself.
  targetFile?: string;
  // M114 B5 / I7 (react-spectrum-F3): the barrel and the specifier that did not
  // resolve, in place of a props table nothing could have filled.
  unresolvedReExport?: { barrel: string; specifier: string };
  warnings: string[];
  warningRecords: PropWarningRecord[];
}


const ITEMS_PATTERN = /items|options|data|children|entries|records|elements|list/i;

const SCALING_NAME_PATTERN = /count|size|length|limit|max|total|depth|level|columns|rows|pages/i;

const NUMERIC_SHORTHAND = /^n$|^num/i;

const ARIA_PATTERN = /^aria-/;

// M103 (base-ui-F3): a numeric prop whose name denotes a bound or a step is
// not a quantity of rendered things. `NumberFieldRoot.max` matched
// SCALING_NAME_PATTERN's `/max/i` and ran a whole curve mode whose own output
// then reported that the DOM node count never moved. Exact names only: a
// `maxItems` or `rowCount` still scales.
const SCALING_BOUND_NAME =
  /^(min|max|step|largeStep|smallStep|precision|decimalScale|tabIndex|zIndex|maxLength|minLength|maxWidth|minWidth|maxHeight|minHeight)$/i;


export function detectScalingProps(schemas: PropSchema[]): ScalingPropMatch[] {
  const matches: ScalingPropMatch[] = [];

  for (const schema of schemas) {
    if (ARIA_PATTERN.test(schema.name)) continue;
    if (schema.kind === "array" && ITEMS_PATTERN.test(schema.name)) {
      matches.push({ schema, kind: "array", reason: "array prop with items-like name" });
    } else if (schema.kind === "array") {
      matches.push({ schema, kind: "array", reason: "array prop" });
    } else if (schema.kind === "number" && SCALING_BOUND_NAME.test(schema.name)) {
      continue;
    } else if (schema.kind === "number" && SCALING_NAME_PATTERN.test(schema.name)) {
      matches.push({ schema, kind: "numeric", reason: "numeric prop name matches scaling pattern" });
    } else if (schema.kind === "number" && NUMERIC_SHORTHAND.test(schema.name)) {
      matches.push({ schema, kind: "numeric", reason: "numeric prop" });
    }
  }

  const priority: Record<string, number> = {
    "array prop with items-like name": 0,
    "array prop": 1,
    "numeric prop name matches scaling pattern": 2,
    "numeric prop": 3,
  };
  matches.sort((a, b) => priority[a.reason] - priority[b.reason]);

  return matches;
}


export async function extractProps(
  filePath: string,
  options?: ExtractPropsOptions,
): Promise<PropSchema[]> {
  return (await extractPropsDetailed(filePath, options)).schemas;
}


// M65: the same resolution `extractProps` performs, plus the binding facts a
// dry run has to show. `extractProps` is the schema-only view of it.
export async function extractPropsDetailed(
  filePath: string,
  options?: ExtractPropsOptions,
): Promise<PropsExtraction> {
  const absolutePath = path.resolve(filePath);
  const warnings: string[] = [];
  const sink = (message: string): void => {
    const line = message.trimEnd();
    warnings.push(line);
    // The trailing newline belongs to the stderr write inside `warnOnce`. A
    // sink consumer renders the text as a list entry; a newline there prints a
    // stray blank line in the report and rides along in the report JSON.
    options?.onWarning?.(line);
  };
  const collecting = options?.onWarning !== undefined;
  // M112 B3: records are collected whether or not a sink is printing, because
  // `warnOnce` prints a given warning once per process and the second caller
  // still has to be able to re-render it.
  const warningRecords: PropWarningRecord[] = [];
  const record: WarningRecorder = (entry) => {
    warningRecords.push(entry);
  };

  if (isVueFile(absolutePath)) {
    const schemas = await extractVueProps(absolutePath, collecting ? sink : undefined, record);
    return { schemas, warnings, warningRecords };
  }

  const compilerOptions = createCompilerOptions(absolutePath);
  // M97 / ADR 0004: a JavaScript entry's declared types live in a sibling
  // `.d.ts`. It joins the program as a second root so its symbols bind.
  const declarationPath = isJsEntry(absolutePath)
    ? resolveEntryDeclaration(absolutePath, compilerOptions)
    : undefined;
  const program = createCachedProgram(
    absolutePath,
    compilerOptions,
    undefined,
    declarationPath ? [declarationPath] : undefined,
  );
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(absolutePath);

  if (!sourceFile) {
    throw new Error(`Could not parse ${filePath}`);
  }

  // M81 section 6: the classification loop's own try/catch (inside
  // `typeToSchema`) covers a recursion that surfaces per-prop; this outer
  // guard covers one that surfaces resolving the target's props type itself,
  // before or during that loop, so a self-referential generic never reaches
  // the CLI as a bare, unattributed crash.
  let binding: PropsBinding = {};
  let schemas: PropSchema[] = [];
  let recursed = false;
  try {
    binding = findComponentPropsType(
      sourceFile,
      checker,
      options?.target,
      collecting ? sink : undefined,
    );
    // M97 / ADR 0004: the sibling declaration is the published contract, so it
    // outranks `bindProps`'s last resort (the call signatures of the binding's
    // own type) and answers where the JavaScript source binds nothing at all.
    // The bound function is kept: its destructured names are what the
    // source-reference ranking reads.
    if (declarationPath && (binding.type === undefined || binding.viaTypeFallback)) {
      const declared = propsFromDeclaration(declarationPath, program, checker);
      if (declared) binding = { ...binding, type: declared };
    }
    if (binding.type === undefined && binding.unboundTargetHijacked && binding.targetName) {
      warnUnboundTarget(absolutePath, binding.targetName, collecting ? sink : undefined);
    }
    schemas = binding.type
      ? typeToSchema(
          binding.type,
          checker,
          absolutePath,
          collecting ? sink : undefined,
          binding.fn,
          record,
        )
      : [];
    // M103 (I8): the component's own declared defaults, destructuring first —
    // it is the form a reader of the source sees.
    schemas = applyDeclaredDefaults(
      schemas,
      destructuredParameterDefaults(binding.fn),
      "destructuring",
    );
    if (binding.targetName) {
      schemas = applyDeclaredDefaults(
        schemas,
        defaultPropsAssignment(sourceFile, binding.targetName),
        "defaultProps",
      );
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    recursed = true;
    warnRecursiveType(
      absolutePath,
      binding.targetName ?? path.basename(absolutePath),
      collecting ? sink : undefined,
    );
  }

  if (!recursed && schemas.length === 0 && binding.computedAnnotation && binding.targetName) {
    warnUnenumerableProps(
      absolutePath,
      binding.targetName,
      binding.computedAnnotation,
      collecting ? sink : undefined,
    );
  }
  if (!recursed) {
    warnDegenerateProps(absolutePath, schemas, collecting ? sink : undefined, record);
  }
  // M97 / ADR 0004: an empty JS schema now names its own cause instead of
  // reaching analyze.ts's generic "extraction may have failed" hedge.
  if (
    !recursed &&
    schemas.length === 0 &&
    isJsEntry(absolutePath) &&
    binding.targetName !== undefined &&
    binding.computedAnnotation === undefined
  ) {
    warnUntypedJsComponent(
      absolutePath,
      binding.targetName,
      declarationPath,
      collecting ? sink : undefined,
    );
  }

  return {
    schemas,
    ...(binding.targetName !== undefined ? { targetName: binding.targetName } : {}),
    ...(binding.targetLine !== undefined ? { targetLine: binding.targetLine } : {}),
    ...(binding.targetFile !== undefined ? { targetFile: binding.targetFile } : {}),
    ...(binding.unresolvedReExport !== undefined
      ? { unresolvedReExport: binding.unresolvedReExport }
      : {}),
    ...(binding.computedAnnotation !== undefined
      ? { computedAnnotation: binding.computedAnnotation }
      : {}),
    warnings,
    warningRecords,
  };
}


// M97 / ADR 0004: a JavaScript entry that bound no props type and had no
// declaration file to read. material-ui-F1 is what silence here produced:
// `React.forwardRef`'s own `ref`/`key` were reported as the contract and every
// measured combo mounted with `{}`. Same register as the two Vue scope
// exclusions above -- a stated cause rather than the generic
// "extraction may have failed" hedge.
const UNTYPED_JS_COMPONENT_MARK = "declares no props type";


export const UNTYPED_JS_COMPONENT_WARNING = (
  absolutePath: string,
  targetName: string,
  // Review B-2: the declaration that WAS read, when one resolved. Saying "has
  // no declaration file beside it" with `Widget.d.ts` on disk is the same class
  // of false claim M97 section 4 fixed for `warnUnboundTarget`.
  declarationPath?: string,
): string => {
  const source = declarationPath
    ? `${UNTYPED_JS_COMPONENT_MARK}: ${path.basename(declarationPath)} was read and declares none for it either`
    : `${UNTYPED_JS_COMPONENT_MARK} and has no declaration file beside it (a sibling <stem>.d.ts is read when one exists, ADR 0004)`;
  // Review B-3: with a preset on disk, applyPropPresets's append path supplies
  // the props and the run measures them, so "measuring with no props" is false.
  const outcome = detectPropPresets(absolutePath)
    ? `${presetFileName(absolutePath)} next to it supplies the values measured instead.`
    : `measuring with no props. Add ${presetFileName(absolutePath)} next to it to supply values.`;
  return `Warning: ${targetName} in ${absolutePath} ${source}: ${outcome}` + "\n";
};


// Lets src/analyze.ts recognize this specific warning, so the generic
// ZERO_PROPS_WARNING does not stack on top of a cause already stated.
export function isUntypedJsComponentWarning(message: string): boolean {
  return message.includes(UNTYPED_JS_COMPONENT_MARK);
}


// M97 / ADR 0004 ---------------------------------------------------------------

const JS_ENTRY_EXTENSION = /\.(js|jsx|mjs|cjs)$/i;


function isJsEntry(absolutePath: string): boolean {
  return JS_ENTRY_EXTENSION.test(absolutePath);
}


// One warning per target per process (mirrors the tsconfig warning policy).
const warnedPropTargets = new Set<string>();


function warnOnce(key: string, message: string): void {
  if (warnedPropTargets.has(key)) return;
  warnedPropTargets.add(key);
  process.stderr.write(message);
}


// A sink replaces the stderr write entirely: a dry run collects the same text
// as data, and the once-per-process dedupe must not hide it from the second
// caller that asks.
export function emit(key: string, message: string, sink?: (message: string) => void): void {
  if (sink) {
    sink(message);
    return;
  }
  warnOnce(key, message);
}


function warnUnboundTarget(
  fileName: string,
  targetName: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::${targetName}`,
    `Warning: could not resolve props for ${targetName} in ${fileName}: measuring with no props. ` +
      `Another declaration in this file has props, but it is not the component being measured.\n`,
    sink,
  );
}


function warnUnenumerableProps(
  fileName: string,
  targetName: string,
  annotation: string,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::computed::${targetName}`,
    `Warning: props type ${annotation} for ${targetName} in ${fileName} could not be enumerated: ` +
      `measuring with no props. Add ${presetFileName(fileName)} to supply values.\n`,
    sink,
  );
}


function warnUntypedJsComponent(
  fileName: string,
  targetName: string,
  declarationPath: string | undefined,
  sink?: (message: string) => void,
): void {
  emit(
    `${path.resolve(fileName)}::untyped-js::${targetName}`,
    UNTYPED_JS_COMPONENT_WARNING(fileName, targetName, declarationPath),
    sink,
  );
}

export function resetWarnOnceCache(): void {
  warnedPropTargets.clear();
}
