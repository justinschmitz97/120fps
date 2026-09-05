import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { detectComponentExport } from "../harness/index.js";
import {
  buildFixtureScaffold,
  buildUncomposedFixtureScaffold,
  fixtureScaffoldPath,
  scanJsxComposedLocalImports,
  type CompositionTree,
  type ExportInfo,
} from "../props/index.js";
import { runPreflight, isVueFile, projectCompilerOptions } from "../project/index.js";
import { toPosix } from "../shared/index.js";

// --target throws TARGET_WITH_FIXTURE_ERROR unless the fixture is the auto-detected sibling.
export type FixtureProvenance = "sibling" | "explicit-flag" | "fixture-input";

const JSX_COMPOSED_CHILD_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

// base is an already-resolved, extensionless path.
function resolveJsxChildCandidates(base: string): string | undefined {
  const candidates = [
    ...JSX_COMPOSED_CHILD_EXTENSIONS.map((ext) => base + ext),
    ...JSX_COMPOSED_CHILD_EXTENSIONS.map((ext) => path.join(base, "index" + ext)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function resolveRelativeJsxChild(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return resolveJsxChildCandidates(path.resolve(path.dirname(fromFile), specifier));
  }
  // A bare specifier resolves through tsconfig baseUrl/paths, as the import-graph walk does.
  const compilerOptions = projectCompilerOptions(fromFile);
  const resolved = ts.resolveModuleName(specifier, fromFile, compilerOptions, ts.sys).resolvedModule;
  if (!resolved) return undefined;
  const target = path.normalize(resolved.resolvedFileName);
  // A specifier resolving into node_modules is a dependency, not a local composed child.
  if (resolved.isExternalLibraryImport || /[\\/]node_modules[\\/]/.test(target)) return undefined;
  return fs.existsSync(target) ? target : undefined;
}

// runPreflight's async-component check reads entries[0] only, so each child needs its own pass.
export function composedChildPreflightHits(
  targetFile: string,
  projectRoot: string,
): import("../project/index.js").PreflightHit[] {
  if (isVueFile(targetFile)) return [];
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(targetFile, "utf-8");
  } catch {
    return [];
  }
  const composed = scanJsxComposedLocalImports(sourceText, targetFile);
  if (composed.length === 0) return [];

  const targetRel = toPosix(path.relative(projectRoot, targetFile));
  const hits: import("../project/index.js").PreflightHit[] = [];
  for (const { specifier } of composed) {
    const resolved = resolveRelativeJsxChild(targetFile, specifier);
    if (!resolved || isVueFile(resolved)) continue;
    const childName = detectComponentExport(resolved).name;
    const childResult = runPreflight({ projectRoot, entries: [resolved], componentName: childName });
    // Only hard hits merge back; soft signals inside a child's own graph are out of scope.
    for (const hit of childResult.hard) {
      hits.push({ ...hit, chain: [targetRel, ...hit.chain] });
    }
  }
  return hits;
}

// Opt-in only: "no source file modification" (00-tdd.md NFRs) rules out an unasked write.
export function writeFixtureScaffold(
  componentPath: string,
  exports: import("../props/index.js").ExportInfo[],
  tree: CompositionTree,
): string {
  const target = fixtureScaffoldPath(componentPath);
  if (fs.existsSync(target)) {
    return `--init-fixture skipped: ${target} already exists`;
  }
  const stem = path.basename(componentPath, path.extname(componentPath));
  fs.writeFileSync(target, buildFixtureScaffold(stem, exports, tree), "utf8");
  return `wrote fixture scaffold ${target}; edit it to render the real composition, then re-run`;
}

// Returning the line rather than printing it keeps both sites on the run's one warning channel.
export function initFixtureOutcome(
  componentPath: string,
  root: string,
  siblings: string[],
  // The measured file's own exports, so the scaffold imports only names that resolve from it.
  exports: ExportInfo[] = [],
): string {
  const target = fixtureScaffoldPath(componentPath);
  if (fs.existsSync(target)) {
    return `--init-fixture skipped: ${target} already exists`;
  }
  const stem = path.basename(componentPath, path.extname(componentPath));
  // An EACCES or a read-only checkout is an outcome line, never a throw out of the run.
  try {
    fs.writeFileSync(
      target,
      buildUncomposedFixtureScaffold(stem, root, siblings, exports),
      "utf8",
    );
  } catch (error) {
    return `--init-fixture skipped: ${target} could not be written (${(error as Error).message})`;
  }
  return `wrote fixture scaffold ${target}; edit it to render the real composition, then re-run`;
}

// Errors are returned, not thrown: an invalid composition is a fallback signal, not a run failure.
export async function trialMountComposition(
  page: import("playwright").Page,
): Promise<import("../props/index.js").CompositionTrial> {
  try {
    await page.evaluate(() => (window as any).__120fps.mount({}));
    const rootElements = await page.evaluate(
      () => document.getElementById("root")?.querySelectorAll("*").length ?? 0,
    );
    await page.evaluate(() => (window as any).__120fps.unmount());
    return { rootElements };
  } catch (error) {
    return { rootElements: 0, error };
  }
}

export function hasScaleExport(source: string): boolean {
  return /export\s+(?:function|const)\s+scale\b/.test(source);
}

export function isFixturePath(filePath: string): boolean {
  return /\.fixture\.([jt]sx?|vue)$/.test(filePath);
}

export function detectFixture(componentPath: string): string | undefined {
  const ext = path.extname(componentPath);
  const stem = componentPath.slice(0, -ext.length);
  // One component per SFC leaves auto-composition nothing to infer, so Vue composes in a fixture.
  const candidates = isVueFile(componentPath)
    ? [`${stem}.fixture.vue`]
    : [`${stem}.fixture.tsx`, `${stem}.fixture.ts`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
