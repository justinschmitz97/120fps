import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { scanExports, selectMeasuredExport } from "../props/index.js";
import { isVueFile, type VueSfcCompiler } from "../project/index.js";
import { isOutsideRoot } from "./renderer.js";
import { isFile, toPosix } from "../shared/index.js";

// A kebab-case SFC filename is not an identifier: my-button.vue must not import My-button.
export function vueComponentName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  const name = stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z_$]/.test(name) ? name : `Component${name}`;
}

// Probe order is significant: first hit wins.
export const WRAPPER_CANDIDATES = [
  "120fps.setup.tsx",
  "120fps.setup.jsx",
  "120fps.setup.ts",
  "120fps.setup.js",
  "120fps.setup.vue",
];

// A .tsx wrapper cannot render a Vue component, so a Vue project probes the SFC first.
export function detectWrapper(projectRoot: string, framework?: string): string | undefined {
  const candidates =
    framework === "vue"
      ? ["120fps.setup.vue", ...WRAPPER_CANDIDATES.filter((c) => c !== "120fps.setup.vue")]
      : WRAPPER_CANDIDATES;
  for (const name of candidates) {
    const candidate = path.join(projectRoot, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

// The wrapper imports CSS and browser-only packages, so Node cannot evaluate it to check.
function hasCallableDefaultExport(sourceText: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  let found = false;

  ts.forEachChild(sourceFile, (node) => {
    if (found) return;

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      const notCallable =
        ts.isObjectLiteralExpression(expr) ||
        ts.isArrayLiteralExpression(expr) ||
        ts.isNumericLiteral(expr) ||
        ts.isStringLiteral(expr) ||
        ts.isNoSubstitutionTemplateLiteral(expr) ||
        expr.kind === ts.SyntaxKind.TrueKeyword ||
        expr.kind === ts.SyntaxKind.FalseKeyword ||
        expr.kind === ts.SyntaxKind.NullKeyword;
      if (!notCallable) found = true;
      return;
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      found = true;
      return;
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        if (!spec.isTypeOnly && spec.name.text === "default") found = true;
      }
    }
  });

  return found;
}

// plugin-vue imports the <script> block, so a block that exports no component fails to load.
export function sfcProducesComponent(
  source: string,
  fileName: string,
  compiler: VueSfcCompiler,
): boolean {
  let descriptor;
  try {
    descriptor = compiler.parse(source, { filename: fileName }).descriptor;
  } catch {
    // A malformed SFC is the plugin's error to report, with real positions.
    return true;
  }
  const setup = descriptor?.scriptSetup;
  const script = descriptor?.script;
  if (!setup && !script) return true;
  // An empty <script setup> counts as absent to the compiler.
  if (setup && setup.content.trim().length > 0) return true;
  if (script && hasAnyDefaultExport(script.content, `${fileName}.ts`)) return true;
  return false;
}

// Vue's Options API default-exports a plain object, which hasCallableDefaultExport rejects.
function hasAnyDefaultExport(sourceText: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  let found = false;

  ts.forEachChild(sourceFile, (node) => {
    if (found) return;
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      found = true;
      return;
    }
    if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      found = true;
      return;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        if (!spec.isTypeOnly && spec.name.text === "default") found = true;
      }
    }
  });

  return found;
}

export const SFC_NO_COMPONENT = (relative: string): string =>
  `${relative} has a <script> block that exports no component, so nothing can be mounted from it. ` +
  "Add `export default` to that block, or move the code into a non-empty <script setup> " +
  "(an empty <script setup> counts as absent to the Vue compiler).";

export function resolveWrapper(wrapPath: string, projectRoot: string): string {
  const absolute = path.resolve(wrapPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Wrapper module not found: ${wrapPath}`);
  }
  const relative = toPosix(path.relative(projectRoot, absolute));
  // A wrapper on another Windows drive has an absolute relative form and no "../" prefix.
  if (isOutsideRoot(absolute, projectRoot)) {
    throw new Error(
      `Wrapper module ${wrapPath} must live inside the project root ${projectRoot}`,
    );
  }
  const source = fs.readFileSync(absolute, "utf-8");
  if (isVueFile(absolute)) {
    // An SFC's default export is its component by construction; only SFC-ness is provable.
    if (!/<template[\s>]|<script[\s>]/.test(source)) {
      throw new Error(
        `Wrapper module ${wrapPath} must be a Vue single-file component rendering its default slot`,
      );
    }
    return relative;
  }
  if (!hasCallableDefaultExport(source, absolute)) {
    throw new Error(
      `Wrapper module ${wrapPath} must default-export a React component taking { children }`,
    );
  }
  return relative;
}

export function detectScaleExport(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");
  return /export\s+(?:function|const)\s+scale\b/.test(content);
}

// Available exports are listed so the message is a menu rather than a rejection.
export function targetNotFoundMessage(
  filePath: string,
  target: string,
  available: string[],
): string {
  const where = path.basename(filePath);
  return available.length > 0
    ? `Export "${target}" not found in ${where}. Available component exports: ${available.join(", ")}`
    : `Export "${target}" not found in ${where}, which exports no components.`;
}

// A *Provider export needs an externally-managed value; selectMeasuredExport ranks it last.
export function detectComponentExport(
  filePath: string,
  target?: string,
): {
  name: string;
  isDefaultOnly: boolean;
} {
  // One SFC, one component, always the default export: there is nothing to select.
  if (isVueFile(filePath)) {
    const name = vueComponentName(filePath);
    if (target && target !== name) throw new Error(targetNotFoundMessage(filePath, target, [name]));
    return { name, isDefaultOnly: true };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const exports = scanExports(content, filePath);

  if (target) {
    if (!exports.some((e) => e.name === target)) {
      throw new Error(targetNotFoundMessage(filePath, target, exports.map((e) => e.name)));
    }
  }

  const picked = selectMeasuredExport(exports, filePath, target);
  if (picked !== undefined) {
    const info = exports.find((e) => e.name === picked)!;
    return { name: info.name, isDefaultOnly: info.isDefault };
  }

  const basename = path.basename(filePath, path.extname(filePath));
  const name = basename.charAt(0).toUpperCase() + basename.slice(1);
  return { name, isDefaultOnly: true };
}
