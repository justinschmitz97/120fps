import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildAndServe, findProjectRoot, type HarnessResult } from "../harness/index.js";
import { extractProps } from "../props/index.js";
import { generateCombinations, selectRepresentativeCombos, type PropCombination } from "../props/index.js";
import {
  createBrowserPool,
  enterHarness,
  openMeasurementSession,
  runMountUnmount,
  type BrowserPool,
  type MeasurementSession,
} from "../browser/index.js";
import { computeMedian, toPosix } from "../shared/index.js";

export interface CompareSideMetrics {
  mountSamples: number[];
  mountMedian: number;
  unmountMedian: number;
  domNodeCount: number;
}

export interface CompareCombo {
  comboIndex: number;
  props: Record<string, unknown>;
  working: CompareSideMetrics;
  reference: CompareSideMetrics;
  mountDeltaPercent: number;
  distinguishable: boolean;
}

export interface CompareReport {
  ref: string;
  componentPath: string;
  combos: CompareCombo[];
  warnings?: string[];
}

// Only non-overlapping spreads say the difference outlived the noise; medians always differ.
export function distinguishable(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const aMin = Math.min(...a);
  const aMax = Math.max(...a);
  const bMin = Math.min(...b);
  const bMax = Math.max(...b);
  return aMax < bMin || bMax < aMin;
}

export function deltaPercent(from: number, to: number): number {
  if (!(from > 0)) return 0;
  return ((to - from) / from) * 100;
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];

function lockfileHash(root: string): string {
  const parts: string[] = [];
  for (const name of LOCKFILES) {
    const candidate = path.join(root, name);
    try {
      parts.push(name + ":" + crypto.createHash("sha1").update(fs.readFileSync(candidate)).digest("hex"));
    } catch {
      // Absent lockfiles are part of the identity.
      parts.push(name + ":absent");
    }
  }
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex");
}

export const DEPENDENCY_DRIFT_ERROR = (ref: string): string =>
  `Dependencies differ between the working tree and ${ref}. The reference worktree would need its ` +
  "own install, and measuring one side against another side's node_modules compares the wrong thing. " +
  "Compare against a ref with the same lockfile, or install and re-run.";

export function validateCompareOptions(options: {
  compare?: string;
  check?: boolean;
  saveBaseline?: boolean;
  isolation?: unknown;
}): string | undefined {
  if (!options.compare) return undefined;
  if (options.check) return "--compare cannot be combined with --check: compare informs a human, budgets own CI.";
  if (options.saveBaseline) return "--compare cannot be combined with --save-baseline: there are two sets of numbers, and a baseline holds one.";
  if (options.isolation) return "--compare cannot be combined with --isolate.";
  return undefined;
}

// `.120fps-` prefix: the stale-harness sweep and other agents must recognise the dir as ours.
function worktreeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), ".120fps-compare-"));
}

// Under pnpm workspaces the renderer lives in the member's own node_modules, not just the root's.
export function nodeModulesLinkDirs(repoRoot: string, memberRoot: string): string[] {
  const relative = path.relative(repoRoot, memberRoot);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  const dirs = [""];
  let current = "";
  if (inside) {
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      dirs.push(current);
    }
  }
  return dirs.filter((dir) => fs.existsSync(path.join(repoRoot, dir, "node_modules")));
}

// A fresh worktree has no install of its own; linking is sound only because the lockfiles matched.
export function linkNodeModules(repoRoot: string, worktree: string, memberRoot: string): void {
  for (const dir of nodeModulesLinkDirs(repoRoot, memberRoot)) {
    const source = path.join(repoRoot, dir, "node_modules");
    const target = path.join(worktree, dir, "node_modules");
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Junction on Windows: a directory symlink there needs privileges a plain user lacks.
      fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // A boot failure surfaces through the normal readiness path; copying node_modules is worse.
    }
  }
}

// Worktree teardown walks into a junction and would delete through it into the real node_modules.
export function unlinkNodeModules(worktree: string, repoRoot: string, memberRoot: string): void {
  for (const dir of nodeModulesLinkDirs(repoRoot, memberRoot)) {
    const target = path.join(worktree, dir, "node_modules");
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) continue;
      // rmdirSync detaches a Windows junction; POSIX rmdir refuses a symlink, so unlinkSync there.
      if (process.platform === "win32") fs.rmdirSync(target);
      else fs.unlinkSync(target);
    } catch {
      // Already gone, or linkNodeModules itself never created it: nothing to detach.
    }
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A SIGKILL mid-compare leaves .git/worktrees/<name> registered, and nothing else sweeps it.
export function pruneStaleWorktrees(repoRoot: string): void {
  try {
    git(["worktree", "prune"], repoRoot);
  } catch {
    // A corrupt .git, a missing git, or a non-repo root must not stop the compare.
  }
}

export interface CompareOptions {
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  maxCombos?: number;
}

export async function compareAgainstRef(
  componentPath: string,
  ref: string,
  options: CompareOptions = {},
): Promise<CompareReport> {
  const {
    samples = 10,
    cpuThrottle = 4,
    warmupRuns = 2,
    maxCombos = 4,
  } = options;

  const resolved = path.resolve(componentPath);
  if (!fs.existsSync(resolved)) throw new Error(`Component not found: ${componentPath}`);

  const projectRoot = findProjectRoot(path.dirname(resolved)) ?? path.dirname(resolved);
  let repoRoot: string;
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"], projectRoot);
  } catch {
    throw new Error(`--compare needs a git repository; ${projectRoot} is not inside one.`);
  }
  try {
    git(["rev-parse", "--verify", `${ref}^{commit}`], repoRoot);
  } catch {
    throw new Error(`--compare ${ref}: no such commit in this repository.`);
  }

  const relativeComponent = toPosix(path.relative(repoRoot, resolved));
  const dir = worktreeDir();
  const warnings: string[] = [];
  // Both sides can fail to settle fonts independently; one line per distinct message.
  const onWarning = (warning: string): void => {
    if (!warnings.includes(warning)) warnings.push(warning);
  };

  let harnessWorking: HarnessResult | undefined;
  let harnessReference: HarnessResult | undefined;
  let sessionWorking: MeasurementSession | undefined;
  let sessionReference: MeasurementSession | undefined;
  let pool: BrowserPool | undefined;

  try {
    pruneStaleWorktrees(repoRoot);
    git(["worktree", "add", "--detach", dir, ref], repoRoot);

    // Identical dependency sets are what let the reference side resolve through this install.
    if (lockfileHash(repoRoot) !== lockfileHash(dir)) {
      throw new Error(DEPENDENCY_DRIFT_ERROR(ref));
    }
    linkNodeModules(repoRoot, dir, projectRoot);

    const referencePath = path.join(dir, relativeComponent);
    if (!fs.existsSync(referencePath)) {
      throw new Error(
        `${relativeComponent} does not exist at ${ref}. There is nothing to compare the working tree against.`,
      );
    }

    // The working tree's schema: a prop it does not have is not a question the user asked.
    const schemas = await extractProps(resolved);
    let combos: PropCombination[] = generateCombinations(schemas);
    if (combos.length === 0) combos = [{}];
    if (combos.length > maxCombos) {
      const kept = selectRepresentativeCombos(combos.length, maxCombos);
      warnings.push(
        `compared ${kept.length} of ${combos.length} prop combos; interleaving doubles every sample.`,
      );
      combos = kept.map((i) => combos[i]);
    }

    harnessWorking = await buildAndServe(resolved);
    harnessReference = await buildAndServe(referencePath);

    pool = createBrowserPool();
    sessionWorking = await openMeasurementSession({ driven: true, pool });
    sessionReference = await openMeasurementSession({ driven: true, pool });

    await enterHarness(sessionWorking.page, sessionWorking.session.cdp, harnessWorking, sessionWorking.errorCapture, {
      label: "compare working tree",
      cpuThrottle,
      onWarning,
    });
    await enterHarness(
      sessionReference.page,
      sessionReference.session.cdp,
      harnessReference,
      sessionReference.errorCapture,
      { label: `compare ${ref}`, cpuThrottle, onWarning },
    );

    for (let w = 0; w < warmupRuns; w++) {
      await runMountUnmount(sessionWorking.page, sessionWorking.session.cdp, combos[0], false);
      await runMountUnmount(sessionReference.page, sessionReference.session.cdp, combos[0], false);
    }

    const results: CompareCombo[] = [];
    for (let ci = 0; ci < combos.length; ci++) {
      const props = combos[ci];
      const working: number[] = [];
      const reference: number[] = [];
      const workingUnmount: number[] = [];
      const referenceUnmount: number[] = [];
      let workingNodes = 0;
      let referenceNodes = 0;

      // Interleaved per sample, so both sides share one thermal and contention window.
      for (let s = 0; s < samples; s++) {
        const a = await runMountUnmount(sessionWorking.page, sessionWorking.session.cdp, props, s === 0);
        const b = await runMountUnmount(sessionReference.page, sessionReference.session.cdp, props, s === 0);
        working.push(a.mountDur);
        reference.push(b.mountDur);
        workingUnmount.push(a.unmountDur);
        referenceUnmount.push(b.unmountDur);
        if (s === 0) {
          workingNodes = a.domNodeCount;
          referenceNodes = b.domNodeCount;
        }
      }

      const workingMedian = computeMedian(working);
      const referenceMedian = computeMedian(reference);
      results.push({
        comboIndex: ci,
        props: props as Record<string, unknown>,
        working: {
          mountSamples: working,
          mountMedian: workingMedian,
          unmountMedian: computeMedian(workingUnmount),
          domNodeCount: workingNodes,
        },
        reference: {
          mountSamples: reference,
          mountMedian: referenceMedian,
          unmountMedian: computeMedian(referenceUnmount),
          domNodeCount: referenceNodes,
        },
        // Reference is the "from": the question is what the working tree did to it.
        mountDeltaPercent: deltaPercent(referenceMedian, workingMedian),
        distinguishable: distinguishable(working, reference),
      });
    }

    return {
      ref,
      componentPath: relativeComponent,
      combos: results,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } finally {
    if (sessionWorking) await sessionWorking.close();
    if (sessionReference) await sessionReference.close();
    if (pool) await pool.closeAll();
    if (harnessWorking) await harnessWorking.cleanup();
    if (harnessReference) await harnessReference.cleanup();
    // Detach the junctions before teardown walks the worktree and deletes through them.
    unlinkNodeModules(dir, repoRoot, projectRoot);
    // Every exit path: a leaked worktree interferes with every other tool in the repo.
    try {
      git(["worktree", "remove", "--force", dir], repoRoot);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function formatCompare(report: CompareReport): string {
  const lines: string[] = [
    `Compare: working tree vs ${report.ref}: ${report.componentPath}`,
    "",
  ];
  for (const combo of report.combos) {
    const props = Object.keys(combo.props).length > 0 ? JSON.stringify(combo.props) : "{}";
    const sign = combo.mountDeltaPercent >= 0 ? "+" : "";
    const verdict = !combo.distinguishable
      ? "indistinguishable"
      : combo.mountDeltaPercent < 0
        ? "faster"
        : "slower";
    lines.push(
      `  ${props}`,
      `    mount  ${combo.reference.mountMedian.toFixed(2)}ms → ${combo.working.mountMedian.toFixed(2)}ms ` +
      `(${sign}${combo.mountDeltaPercent.toFixed(1)}%, ${verdict})`,
      `    nodes  ${combo.reference.domNodeCount} → ${combo.working.domNodeCount}`,
    );
  }
  for (const warning of report.warnings ?? []) lines.push("", `  Note: ${warning}`);
  return lines.join("\n");
}
