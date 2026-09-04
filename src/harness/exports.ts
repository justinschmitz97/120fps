import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { scanExports, selectMeasuredExport } from "../props/index.js";
import { isVueFile, type VueSfcCompiler } from "../project/index.js";
import { isOutsideRoot } from "./renderer.js";

// An SFC's component is its default export and has no exported name, so the
// entry's import binding is derived from the filename. Vue's own convention is
// kebab-case files, which is not an identifier: `my-button.vue` must not
// generate `import My-button`.
export function vueComponentName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  const name = stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z_$]/.test(name) ? name : `Component${name}`;
}

// Probe order is significant: first hit wins (W1).
export const WRAPPER_CANDIDATES = [
  "120fps.setup.tsx",
  "120fps.setup.jsx",
  "120fps.setup.ts",
  "120fps.setup.js",
  "120fps.setup.vue",
];

// A `.tsx` wrapper in a Vue project cannot render a Vue component, so the SFC
// is probed first there: otherwise a stray leftover file would silently break
// the run it was supposed to fix.
export function detectWrapper(projectRoot: string, framework?: string): string | undefined {
  const candidates =
    framework === "vue"
      ? ["120fps.setup.vue", ...WRAPPER_CANDIDATES.filter((c) => c !== "120fps.setup.vue")]
      : WRAPPER_CANDIDATES;
  for (const name of candidates) {
    const candidate = path.join(projectRoot, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // missing or unreadable: try the next candidate
    }
  }
  return undefined;
}

// Static approximation of "default export is a React component": we can only
// rule out the cases that are provably not callable. The wrapper may import
// CSS and browser-only packages, so it cannot be evaluated in Node.
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

// @vitejs/plugin-vue emits `import _sfc_main from "<sfc>?vue&type=script"`
// whenever an SFC has any <script> block, so a block that produces no default
// export fails module evaluation in the browser: the Vue analogue of the
// missing-default-export wrapper M26 fixed for React. An SFC with no <script>
// at all is fine: the plugin synthesizes an empty component for it.
//
// An empty `<script setup>` counts as absent to the compiler, which is the
// shape that looks most correct and fails hardest.
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
  if (setup && setup.content.trim().length > 0) return true;
  if (script && hasAnyDefaultExport(script.content, `${fileName}.ts`)) return true;
  return false;
}

// Vue's Options API default-exports a plain object, which
// `hasCallableDefaultExport` deliberately rejects for React. Here the question
// is only whether the module has a default export at all: the plugin imports
// it either way, and an object is a perfectly good Vue component.
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
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
  // M73: the raw relative path decides, not its forward-slashed form: a wrapper
  // on another Windows drive has an absolute relative form and no "../" prefix.
  if (isOutsideRoot(absolute, projectRoot)) {
    throw new Error(
      `Wrapper module ${wrapPath} must live inside the project root ${projectRoot}`,
    );
  }
  const source = fs.readFileSync(absolute, "utf-8");
  if (isVueFile(absolute)) {
    // An SFC's component is its default export by construction; the only thing
    // provable here is that the file is an SFC at all.
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

// M65: named after the file, listed so the message is a menu rather than a
// rejection.
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

// Selection order (M24 D2, M58/M65 normalization, M103/I9): explicit `#Export`
// target > default export > file-stem match among named exports after dropping
// non-alphanumerics > first PascalCase export in source order **that does not
// end in `Provider`** > first PascalCase export in source order > filename
// fallback. isDefaultOnly is true iff the chosen component is importable as a
// default import.
//
// I9 (chakra-ui-F2): a `*Provider` export is the controlled variant of the
// component beside it — it takes an externally-managed `value` object its
// uncontrolled sibling does not need, and for select/combobox that object is a
// class instance nothing can synthesize. Chakra declares it first
// (`tabs.ts:35` `TabsRootProvider` before `:52` `TabsRoot`), so source order
// alone measured the harder variant on every multi-export file. The rule is
// narrow on purpose: it re-orders the last automatic step only. An explicit
// `#Export`, a default export and a file-stem match are all the author's own
// designation of what the file is, and none of them is second-guessed — a
// `provider.tsx` whose only component is `Provider` still resolves to it.
// The rule itself is `PROVIDER_EXPORT_SUFFIX` in src/prop-gen.ts, applied by
// `selectMeasuredExport`, which this function delegates its ordering to.
export function detectComponentExport(
  filePath: string,
  target?: string,
): {
  name: string;
  isDefaultOnly: boolean;
} {
  // One SFC, one component, always the default export: there is nothing to
  // select and the file is not TypeScript, so the AST walker never runs on it.
  if (isVueFile(filePath)) {
    const name = vueComponentName(filePath);
    if (target && target !== name) throw new Error(targetNotFoundMessage(filePath, target, [name]));
    return { name, isDefaultOnly: true };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const exports = scanExports(content, filePath);

  if (target) {
    // The pick order itself lives in `selectMeasuredExport` (src/prop-gen.ts):
    // review B-8 found two copies of it, each with its own `Provider` regex.
    // This function keeps what is its own — the "export not found" message and
    // the filename fallback — and delegates the ordering.
    if (!exports.some((e) => e.name === target)) {
      throw new Error(targetNotFoundMessage(filePath, target, exports.map((e) => e.name)));
    }
  }

  const picked = selectMeasuredExport(exports, filePath, target);
  if (picked !== undefined) {
    const info = exports.find((e) => e.name === picked)!;
    return { name: info.name, isDefaultOnly: info.isDefault };
  }

  // Fallback: derive from filename, assume default export
  const basename = path.basename(filePath, path.extname(filePath));
  const name = basename.charAt(0).toUpperCase() + basename.slice(1);
  return { name, isDefaultOnly: true };
}
