import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildAndServe, findProjectRoot, type HarnessResult } from "./harness.js";
import { extractProps } from "./prop-gen.js";
import { generateCombinations, selectRepresentativeCombos, type PropCombination } from "./prop-gen-values.js";
import {
  createBrowserPool,
  enterHarness,
  openMeasurementSession,
  runMountUnmount,
  computeMedian,
  type BrowserPool,
  type MeasurementSession,
} from "./measure.js";

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
  // Whether the two sample sets are telling different stories at all.
  distinguishable: boolean;
}

export interface CompareReport {
  ref: string;
  componentPath: string;
  combos: CompareCombo[];
  warnings?: string[];
}

// Ranges, not means. Two medians always differ by something; only
// non-overlapping spreads say the difference outlived the noise. Deliberately
// not a t-test: no statistics machinery until this proves insufficient.
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
      // Absent lockfiles are part of the identity, like M39's missing files.
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

// `.120fps-` prefixed so the stale-harness sweep and any human reading the repo
// recognise it as ours; other agents work in this tree too.
function worktreeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), ".120fps-compare-"));
}

// M68. Every level from the repository root down to the member that has an
// install of its own, root first. Under pnpm workspaces the member's own
// node_modules is where react or vue lives, so linking the repo root alone left
// the reference side unable to resolve the renderer.
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

// A fresh worktree has no install of its own, so the reference harness could
// not resolve react at all. Junction on Windows (no privileges needed), symlink
// elsewhere. Sound only because the lockfiles matched.
export function linkNodeModules(repoRoot: string, worktree: string, memberRoot: string): void {
  for (const dir of nodeModulesLinkDirs(repoRoot, memberRoot)) {
    const source = path.join(repoRoot, dir, "node_modules");
    const target = path.join(worktree, dir, "node_modules");
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Without it the reference harness fails to boot and says so through the
      // normal readiness path; a silent copy of node_modules would be worse.
    }
  }
}

// Windows fix: `git worktree remove` and a naive recursive delete both
// walk into a junction rather than unlinking it, so removing the worktree
// while linkNodeModules's links are still in place deletes files out of
// repoRoot's real node_modules -- the one every other process in the repo,
// including this one, is using. Called before either teardown path, so
// neither ever sees the link. rmdirSync detaches a Windows junction without
// touching its target; a POSIX dir symlink is removed with unlinkSync
// instead, since POSIX rmdir refuses a path that is not itself a directory.
export function unlinkNodeModules(worktree: string, repoRoot: string, memberRoot: string): void {
  for (const dir of nodeModulesLinkDirs(repoRoot, memberRoot)) {
    const target = path.join(worktree, dir, "node_modules");
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) continue;
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

// Best-effort, mirroring sweepStaleHarnessDirs/sweepStaleTmpDirs: a SIGKILL or
// OOM mid-compare escapes the `finally` block's own `git worktree remove` and
// leaves <repoRoot>/.git/worktrees/<name> registered with no working
// directory behind it. Nothing else sweeps that, so it accumulates forever
// and can collide with a fresh `worktree add`. Never blocks a compare run:
// a corrupted .git, a missing `git`, or repoRoot not being a repository at
// all must not stop this from proceeding.
export function pruneStaleWorktrees(repoRoot: string): void {
  try {
    git(["worktree", "prune"], repoRoot);
  } catch {
    // best-effort
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

  const relativeComponent = path.relative(repoRoot, resolved).replace(/\\/g, "/");
  const dir = worktreeDir();
  const warnings: string[] = [];
  // Working and reference sides can each fail to settle fonts independently;
  // one line per distinct message either way.
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

    // The lockfile guard is what makes the next step sound: identical
    // dependency sets mean the reference side can resolve through the working
    // tree's install rather than needing one of its own.
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

    // Combos come from the working tree's schema: it is the side the user is
    // asking about, and a prop it does not have is not a question they asked.
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

      // The whole point of the mode: sample i of one side, then sample i of the
      // other, inside one thermal and contention window. Sequential
      // whole-run-then-whole-run comparison is what this exists to replace.
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
    // Detach linkNodeModules's junction(s) before either teardown path below
    // walks the worktree tree, or that walk deletes through them into
    // repoRoot's real node_modules.
    unlinkNodeModules(dir, repoRoot, projectRoot);
    // Every exit path: a leaked worktree interferes with every other tool in
    // the repo, not just this one.
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
