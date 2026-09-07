import { formatAccumulatedWarnings } from "../pipeline/index.js";
import { presentBundlerFailure } from "../harness/index.js";

// Stack traces are opt-in: the conventional enable-everything DEBUG values.
const DEBUG_EXACT_VALUES = new Set(["1", "true", "*"]);

export function isDebugStackEnabled(debugEnv: string | undefined): boolean {
  if (debugEnv === undefined) return false;
  return DEBUG_EXACT_VALUES.has(debugEnv) || debugEnv.includes("120fps");
}

export function formatCliError(err: unknown, debugEnv: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  let out = `Error: ${message}\n`;
  if (/Executable doesn't exist|playwright install/i.test(message)) {
    out += "Hint: run `npx playwright install chromium`\n";
  }
  if (isDebugStackEnabled(debugEnv) && err instanceof Error && err.stack) {
    out += err.stack + "\n";
  }
  return out;
}

let fatalProcessErrorFired = false;

// A detached async rejection carries no project root; main() sets it per component.
let currentRunProjectRoot: string | undefined;

export function setCurrentRunProjectRoot(root: string | undefined): void {
  currentRunProjectRoot = root;
}

// analyze() cannot import back (cycle), so warnings arrive through an AnalyzeOptions callback.
let currentRunWarnings: string[] = [];

export function pushCurrentRunWarning(warning: string): void {
  if (!currentRunWarnings.includes(warning)) currentRunWarnings.push(warning);
}

export function resetCurrentRunWarnings(): void {
  currentRunWarnings = [];
}

// What the run has said so far, for a caller deciding whether a third party's line adds anything.
export function currentRunWarningList(): readonly string[] {
  return currentRunWarnings;
}

// Rebuild only when the diagnosis changed the message, so the original .stack survives.
function presentDiagnosedProcessError(err: unknown, projectRoot: string): unknown {
  if (!(err instanceof Error)) return err;
  const diagnosed = presentBundlerFailure(err.message, projectRoot);
  if (diagnosed === err.message) return err;
  return new Error(diagnosed, { cause: err });
}

// Appended after diagnosis, so the remedy sentence of a diagnosed message stays first.
function withAccumulatedWarnings(presented: unknown, warnings: readonly string[]): unknown {
  if (warnings.length === 0) return presented;
  const message = presented instanceof Error ? presented.message : String(presented);
  return new Error(message + formatAccumulatedWarnings([...warnings]), { cause: presented });
}

// Exit 2 is the setup/harness bucket; Node default 1 would read as a failed verdict.
export function resolveFatalProcessError(
  err: unknown,
  debugEnv: string | undefined,
  projectRoot: string | undefined = currentRunProjectRoot,
  warnings: readonly string[] = currentRunWarnings,
): { output: string; exitCode: number } | undefined {
  // process.exit does not stop scheduled work, so a second rejection must not print again.
  if (fatalProcessErrorFired) return undefined;
  fatalProcessErrorFired = true;
  const presented = projectRoot ? presentDiagnosedProcessError(err, projectRoot) : err;
  const withWarnings = withAccumulatedWarnings(presented, warnings);
  return { output: formatCliError(withWarnings, debugEnv), exitCode: 2 };
}

// Test-only reset for the module-level guard, like props/program.ts's resetExtractionCache.
export function resetFatalProcessErrorGuard(): void {
  fatalProcessErrorFired = false;
}

// Wording matches pipeline/resolve.ts, so the CLI early exit and the later throw read alike.
export function wrapperNotFoundMessage(wrapPath: string): string {
  return `Wrapper module not found: ${wrapPath}`;
}

export function stylesheetNotFoundMessage(cssPath: string): string {
  return `Stylesheet not found: ${cssPath}`;
}

// package.json engines is declarative only; npx soft-warns, so entry needs a hard gate.
export const MIN_NODE_MAJOR = 22;

function nodeMajorVersion(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : undefined;
}

export function nodeVersionError(version: string): string | undefined {
  const major = nodeMajorVersion(version);
  if (major === undefined || major >= MIN_NODE_MAJOR) return undefined;
  return `Node ${MIN_NODE_MAJOR}+ required, found ${version}`;
}
