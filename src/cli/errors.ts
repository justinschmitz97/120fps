import { formatAccumulatedWarnings } from "../pipeline/index.js";
import { presentBundlerFailure } from "../harness/index.js";

// Stack traces are opt-in: DEBUG must be one of the conventional "enable
// everything" values, or explicitly name 120fps.
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

// Vite's dependency-optimizer scan — fire-and-forget by design, so it must
// not block server.listen() — can reject after buildAndServe's own
// try/catch has already exited successfully; Node's default
// --unhandled-rejections=throw then converts that into a
// process-terminating uncaught exception with a raw esbuild stack, and
// exit code 1, which cli/help.ts's own table documents as "a verdict
// failed" — wrong for a setup/harness failure. This resolver is the pure
// decision the process.on handlers in cli/main.ts apply: same
// formatCliError text every other error path already uses (a raw stack
// only under DEBUG), and the "harness or browser failure" exit bucket (2),
// not Node's default. Exported so the decision is unit-testable without
// touching real process.exit/process.on; only the thin wrapper in
// cli/main.ts performs those.
let fatalProcessErrorFired = false;

// The project root of whichever component is currently being measured, so
// a truly detached async rejection (surface 3 of the shared pipeline,
// harness/bundler-failure.ts's presentBundlerFailure -- a fire-and-forget
// Vite dependency-optimizer scan that rejects after buildAndServe's own
// try/catch already exited successfully) can still be diagnosed. Set by
// main()'s loop before each runOne call; undefined before the first
// component starts or once none is in flight.
let currentRunProjectRoot: string | undefined;

export function setCurrentRunProjectRoot(root: string | undefined): void {
  currentRunProjectRoot = root;
}

// The same shape as currentRunProjectRoot above, for
// the same reason -- surface 3 (a detached async rejection reaching
// process.on("unhandledRejection") directly) runs on a call stack with no
// access to analyze()'s own `runWarnings`/`cssDecisionWarning` locals.
// analyze() cannot report back through an import of this module
// (cli/main.ts already imports pipeline/analyze.ts; the reverse would be a
// cycle), so this is
// populated the same way onProgress already is: a callback threaded through
// AnalyzeOptions, wired to this accumulator at the one call site
// (runOne, below) and read here by ordinary closure, not by importing
// anything back. `pushCurrentRunWarning` is exported directly as the
// callback runOne passes, so nothing here needs re-wrapping.
let currentRunWarnings: string[] = [];

export function pushCurrentRunWarning(warning: string): void {
  if (!currentRunWarnings.includes(warning)) currentRunWarnings.push(warning);
}

export function resetCurrentRunWarnings(): void {
  currentRunWarnings = [];
}

// Rebuilds the error only when presentBundlerFailure actually changed the
// message, so the common case (an ordinary render/setup error, already
// diagnosed by surface 1 or 2, or simply not bundler-shaped) keeps the
// original object -- and its real .stack -- untouched.
function presentDiagnosedProcessError(err: unknown, projectRoot: string): unknown {
  if (!(err instanceof Error)) return err;
  const diagnosed = presentBundlerFailure(err.message, projectRoot);
  if (diagnosed === err.message) return err;
  return new Error(diagnosed, { cause: err });
}

// Appends the identical "Warnings recorded before this failure:" block
// analyze()'s own local catch already builds for surfaces 1 and 2
// (pipeline/analyze.ts) -- this is the same information, made reachable
// here through currentRunWarnings instead of a closure this function has
// no access to. Applied after diagnosis, not before: a diagnosed message's
// own remedy text must stay the lead sentence.
function withAccumulatedWarnings(presented: unknown, warnings: readonly string[]): unknown {
  if (warnings.length === 0) return presented;
  const message = presented instanceof Error ? presented.message : String(presented);
  return new Error(message + formatAccumulatedWarnings([...warnings]), { cause: presented });
}

export function resolveFatalProcessError(
  err: unknown,
  debugEnv: string | undefined,
  projectRoot: string | undefined = currentRunProjectRoot,
  warnings: readonly string[] = currentRunWarnings,
): { output: string; exitCode: number } | undefined {
  // process.exit does not stop already-scheduled work synchronously, so a
  // second rejection arriving before the process actually exits must not
  // print or decide again.
  if (fatalProcessErrorFired) return undefined;
  fatalProcessErrorFired = true;
  // Surface 3 of the shared diagnosis pipeline -- see
  // currentRunProjectRoot's own comment above.
  const presented = projectRoot ? presentDiagnosedProcessError(err, projectRoot) : err;
  const withWarnings = withAccumulatedWarnings(presented, warnings);
  return { output: formatCliError(withWarnings, debugEnv), exitCode: 2 };
}

// Test-only escape hatch for the module-level guard above, matching this
// codebase's existing process-lifetime-cache reset convention
// (props/program.ts's resetExtractionCache).
export function resetFatalProcessErrorGuard(): void {
  fatalProcessErrorFired = false;
}

// Wording kept identical to pipeline/resolve.ts's resolveWrapPath/resolveCssFiles
// re-checks so the CLI's early exit and the pipeline's
// later throw read as the same error either way a run reaches them.
export function wrapperNotFoundMessage(wrapPath: string): string {
  return `Wrapper module not found: ${wrapPath}`;
}

export function stylesheetNotFoundMessage(cssPath: string): string {
  return `Stylesheet not found: ${cssPath}`;
}

// engines: >=22 in package.json (see package.json) is declarative only —
// npx only soft-warns below it. A hard gate at entry turns a confusing
// syntax/runtime crash deep inside a dependency into one clear message.
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
