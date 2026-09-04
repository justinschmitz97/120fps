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

// M110 review: `--target` throws TARGET_WITH_FIXTURE_ERROR whenever the
// fixture came from an explicit --fixture or from the input file itself, so
// the `<file>#Export` remedy is only usable for the auto-detected sibling.
export type FixtureProvenance = "sibling" | "explicit-flag" | "fixture-input";

const JSX_COMPOSED_CHILD_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

// Plain extension-probe resolution for an already-resolved (extensionless)
// candidate base path.
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

// M91 (commerce-F3) / M92: a relative specifier resolves against the
// importing file's own directory by plain extension probing. A bare
// specifier -- commerce's real app/page.tsx composes its async children as
// baseUrl-relative bare specifiers ("components/carousel", no leading "./"),
// which the old dot-prefix check excluded outright, so the one-hop walk
// found zero composed children for exactly the file it exists to cover --
// resolves through the same tsconfig baseUrl/paths machinery runPreflight's
// own import-graph walk already uses (ts.resolveModuleName), not a string
// match on a leading dot. A bare specifier that resolves into node_modules
// is a real dependency, not a local composed child, and is excluded exactly
// like the rest of the graph walk excludes package internals.
function resolveRelativeJsxChild(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return resolveJsxChildCandidates(path.resolve(path.dirname(fromFile), specifier));
  }
  const compilerOptions = projectCompilerOptions(fromFile);
  const resolved = ts.resolveModuleName(specifier, fromFile, compilerOptions, ts.sys).resolvedModule;
  if (!resolved) return undefined;
  const target = path.normalize(resolved.resolvedFileName);
  if (resolved.isExternalLibraryImport || /[\\/]node_modules[\\/]/.test(target)) return undefined;
  return fs.existsSync(target) ? target : undefined;
}

// M91 (commerce-F3): runPreflight's async-component check only inspects
// entries[0] — a sync component whose JSX composes an async server
// component one hop away is invisible to it. Reused unmodified (Lane A's
// file, src/preflight.ts): each JSX-composed local import gets its own
// preflight pass, entries[0] set to the child, reproducing exactly the
// rejection a direct `120fps ./child.tsx` invocation already produces
// correctly. Only hard hits are merged back — soft/transform/provider
// signals one hop into a child's own graph are not this milestone's concern.
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
    for (const hit of childResult.hard) {
      hits.push({ ...hit, chain: [targetRel, ...hit.chain] });
    }
  }
  return hits;
}

// Opt-in only: writing into a project unasked is a side effect the NFRs rule
// out, and an existing fixture is either the user's work or a scaffold they
// already edited.
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

// M112 C3 (radix-themes-F3): the same outcome for the never-composed path,
// where there is no `CompositionTree` to hand `writeFixtureScaffold` — that
// value is `undefined` exactly because auto-composition found no root, so the
// flag could not act there even in principle. Returning the line rather than
// printing it keeps both emission sites on the run's one warning channel, and
// makes "accepted the flag and wrote nothing in silence" unrepresentable.
export function initFixtureOutcome(
  componentPath: string,
  root: string,
  siblings: string[],
  // The measured file's own exports, so the scaffold imports only names that
  // resolve from it and leaves the rest as placeholders.
  exports: ExportInfo[] = [],
): string {
  const target = fixtureScaffoldPath(componentPath);
  if (fs.existsSync(target)) {
    return `--init-fixture skipped: ${target} already exists`;
  }
  const stem = path.basename(componentPath, path.extname(componentPath));
  // The write runs early in analyze(), before measurement: an EACCES or a
  // read-only checkout would otherwise throw out of the run and produce the
  // silence C3 forbids. The failure is an outcome line like any other.
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

// One untimed mount, before calibration, purely to find out whether the
// inferred tree renders. Errors are returned rather than thrown: an invalid
// composition is a fallback signal, not a run failure.
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
  // A compound Vue component composes in a .fixture.vue: one component per SFC
  // leaves auto-composition nothing to infer.
  const candidates = isVueFile(componentPath)
    ? [`${stem}.fixture.vue`]
    : [`${stem}.fixture.tsx`, `${stem}.fixture.ts`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
