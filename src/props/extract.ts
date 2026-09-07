import path from "node:path";
import ts from "typescript";
import { isVueFile, createCompilerOptions } from "../project/index.js";
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
import { createCachedProgram } from "./program.js";
import type { PropSchema, PropWarningRecord, ScalingPropMatch, WarningRecorder } from "./schema.js";
import { extractVueProps } from "./vue.js";

export interface ExtractPropsOptions {
  // Overrides the selection order with the export the user named (`<file>#Export`).
  target?: string;
  // Collects what extraction would have written to stderr, so a dry run prints it as data.
  onWarning?: (message: string) => void;
}


export interface PropsExtraction {
  schemas: PropSchema[];
  // Absent for a Vue SFC, whose props come from defineProps, and for a file with no component.
  targetName?: string;
  targetLine?: number;
  computedAnnotation?: string;
  // Set when the measured file only re-exports the component another module declares.
  targetFile?: string;
  // The barrel and specifier that did not resolve, in place of a props table nothing could fill.
  unresolvedReExport?: { barrel: string; specifier: string };
  warnings: string[];
  warningRecords: PropWarningRecord[];
}


const ITEMS_PATTERN = /items|options|data|children|entries|records|elements|list/i;

const SCALING_NAME_PATTERN = /count|size|length|limit|max|total|depth|level|columns|rows|pages/i;

const NUMERIC_SHORTHAND = /^n$|^num/i;

const ARIA_PATTERN = /^aria-/;

// A bound or a step is no quantity of rendered things; exact names, so `maxItems` still scales.
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


// extractProps is the schema-only view of this.
export async function extractPropsDetailed(
  filePath: string,
  options?: ExtractPropsOptions,
): Promise<PropsExtraction> {
  const absolutePath = path.resolve(filePath);
  const warnings: string[] = [];
  const sink = (message: string): void => {
    // The trailing newline and the "Warning: " prefix belong to warnOnce's stderr write; a list
    // entry gets its prefix from whichever reader prints it.
    const line = message.trimEnd().replace(/^Warning:\s+/, "");
    warnings.push(line);
    options?.onWarning?.(line);
  };
  const collecting = options?.onWarning !== undefined;
  // Collected even with no sink: warnOnce prints once per process, so a second caller re-renders.
  const warningRecords: PropWarningRecord[] = [];
  const record: WarningRecorder = (entry) => {
    warningRecords.push(entry);
  };

  if (isVueFile(absolutePath)) {
    const schemas = await extractVueProps(absolutePath, collecting ? sink : undefined, record);
    return { schemas, warnings, warningRecords };
  }

  const compilerOptions = createCompilerOptions(absolutePath);
  // ADR 0004: a JS entry's sibling `.d.ts` joins the program as a second root so its symbols bind.
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

  // typeToSchema catches per-prop recursion; this guard catches it while resolving the props type.
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
    // ADR 0004: the sibling declaration is the published contract; it outranks the type fallback.
    if (declarationPath && (binding.type === undefined || binding.viaTypeFallback)) {
      const declared = propsFromDeclaration(declarationPath, program, checker);
      // The bound function stays: its destructured names drive the source-reference ranking.
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
    // Destructuring first: it is the form a reader of the source sees.
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
  // ADR 0004: an empty JS schema names its own cause instead of the generic pipeline hedge.
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


// Silence would report forwardRef's own ref/key as the contract and mount every combo with {}.
const UNTYPED_JS_COMPONENT_MARK = "declares no props type";


export const UNTYPED_JS_COMPONENT_WARNING = (
  absolutePath: string,
  targetName: string,
  // Set when a declaration was read; the message must not claim there is none beside it.
  declarationPath?: string,
): string => {
  const source = declarationPath
    ? `${UNTYPED_JS_COMPONENT_MARK}: ${path.basename(declarationPath)} was read and declares none for it either`
    : `${UNTYPED_JS_COMPONENT_MARK} and has no declaration file beside it (a sibling <stem>.d.ts is read when one exists, ADR 0004)`;
  // A preset on disk supplies the props, so "measuring with no props" would be false.
  const outcome = detectPropPresets(absolutePath)
    ? `${presetFileName(absolutePath)} next to it supplies the values measured instead.`
    : `measuring with no props. Add ${presetFileName(absolutePath)} next to it to supply values.`;
  return `Warning: ${targetName} in ${absolutePath} ${source}: ${outcome}` + "\n";
};


// Lets src/pipeline/remedies.ts keep ZERO_PROPS_WARNING off a cause already stated.
export function isUntypedJsComponentWarning(message: string): boolean {
  return message.includes(UNTYPED_JS_COMPONENT_MARK);
}



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


// A sink replaces the stderr write entirely; the once-per-process dedupe must not hide it.
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
