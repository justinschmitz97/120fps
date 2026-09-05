import type { Page } from "playwright";
import { wasImportCycleReported } from "../shared/index.js";

const BUFFER_CAP = 20;

// `fatal` means an uncaught exception, never a console.error: frameworks log warnings there.
export interface PageErrorDrain {
  messages: string[];
  fatal: boolean;
  dropped: number;
}

// `stack` is carried only for the fail-fast path, which uses it to name the throwing module.
export interface FatalPageError {
  message: string;
  stack?: string;
}

export interface PageErrorCapture {
  errors: string[];
  summary(): string;
  drain(): PageErrorDrain;
  // The first pageerror after this call wins; a healthy run never resolves it.
  waitForFatal(): Promise<FatalPageError>;
  // A module that throws during evaluation throws before the readiness wait even exists.
  capturedFatal(): FatalPageError | undefined;
  // A new document ends the old one's fatal, or it would lead the next readiness timeout.
  resetCapturedFatal(): void;
}

// Retention is by distinct message: repeats of one noisy message must not evict the real one.
interface Bucket {
  record(message: string): void;
  rendered(): string[];
  dropped(): number;
  reset(): void;
}

function createBucket(): Bucket {
  let order: string[] = [];
  let counts = new Map<string, number>();
  let droppedCount = 0;
  return {
    record(message) {
      const existing = counts.get(message);
      if (existing !== undefined) {
        counts.set(message, existing + 1);
        return;
      }
      if (counts.size >= BUFFER_CAP) {
        droppedCount++;
        return;
      }
      counts.set(message, 1);
      order.push(message);
    },
    rendered() {
      return order.map((message) => {
        const count = counts.get(message)!;
        return count > 1 ? `${message} (×${count})` : message;
      });
    },
    dropped: () => droppedCount,
    reset() {
      order = [];
      counts = new Map();
      droppedCount = 0;
    },
  };
}

// A synthesized string (props/synthesize.ts) in a plain `<img src>` 404s under the harness root.
export function isHarnessInternalNoise(url: string, harnessDirName: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const escapedDir = harnessDirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^/${escapedDir}/([^/]+)$`));
  if (!match) return false;
  // Every legitimate asset carries an extension, so a real CSS-import 404 still reports.
  return !match[1].includes(".");
}

// Playwright substitutes nothing, so React's `Warning: %s is invalid` arrives with `%s` intact.
export function substituteConsoleFormat(text: string, args: string[]): string {
  const format = args[0];
  // No arguments at all: Playwright's own rendered text is the only form available.
  if (format === undefined) return text;
  const rest = args.slice(1);
  let next = 0;
  let out = "";
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%" || i + 1 >= format.length) {
      out += format[i];
      continue;
    }
    const directive = format[i + 1]!;
    if (directive === "%") {
      out += "%";
      i++;
      continue;
    }
    if (!"sdifoOc".includes(directive)) {
      out += format[i];
      continue;
    }
    if (next >= rest.length) {
      out += format[i];
      continue;
    }
    const argument = rest[next]!;
    next++;
    i++;
    if (directive === "c") continue;
    out += argument;
  }
  const surplus = rest.slice(next);
  return surplus.length > 0 ? [out, ...surplus].join(" ") : out;
}

export function attachPageErrorCapture(page: Page, harnessDirName?: string): PageErrorCapture {
  // The session bucket spans the run; the segment resets per drain so each combo has its cap.
  const session = createBucket();
  const segment = createBucket();
  let segmentFatal = false;
  // Segment-scoped: a combo never inherits the fatal a previous combo already reported.
  let capturedFatal: FatalPageError | undefined;
  // Fresh per call, so a caller that missed an earlier fatal gets the next one, never a replay.
  let fatalWaiters: Array<(fatal: FatalPageError) => void> = [];

  page.on("pageerror", (err) => {
    session.record(err.message);
    segment.record(err.message);
    segmentFatal = true;
    const fatal: FatalPageError = { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
    capturedFatal ??= fatal;
    if (fatalWaiters.length > 0) {
      const waiters = fatalWaiters;
      fatalWaiters = [];
      for (const resolve of waiters) resolve(fatal);
    }
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = substituteConsoleFormat(
      msg.text(),
      msg.args().map((arg) => String(arg)),
    );
    session.record(text);
    segment.record(text);
  });
  // A 404 import kills module evaluation with no exception, so it must not set `fatal`.
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (harnessDirName && isHarnessInternalNoise(url, harnessDirName)) return;
    const failure = request.failure();
    const detail = failure?.errorText ? ` (${failure.errorText})` : "";
    const message = `request failed: ${request.method()} ${url}${detail}`;
    session.record(message);
    segment.record(message);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = response.url();
    if (harnessDirName && isHarnessInternalNoise(url, harnessDirName)) return;
    const message = `response ${response.status()}: ${response.request().method()} ${url}`;
    session.record(message);
    segment.record(message);
  });

  return {
    get errors(): string[] {
      return session.rendered();
    },
    summary() {
      const lines = session.rendered().map((e) => `  - ${e}`);
      const dropped = session.dropped();
      if (dropped > 0) lines.push(`  (+${dropped} more dropped)`);
      return lines.join("\n");
    },
    drain() {
      const result: PageErrorDrain = {
        messages: segment.rendered(),
        fatal: segmentFatal,
        dropped: segment.dropped(),
      };
      segment.reset();
      segmentFatal = false;
      capturedFatal = undefined;
      return result;
    },
    waitForFatal() {
      return new Promise<FatalPageError>((resolve) => {
        fatalWaiters.push(resolve);
      });
    },
    capturedFatal() {
      return capturedFatal;
    },
    resetCapturedFatal() {
      capturedFatal = undefined;
    },
  };
}

// Two windows over one page, merged per combo: mount and rerender, or driven and vsync.
export function mergeDrains(
  first: PageErrorDrain | undefined,
  second: PageErrorDrain | undefined,
): PageErrorDrain | undefined {
  if (!first) return second;
  if (!second) return first;
  const messages = [...first.messages];
  for (const message of second.messages) {
    if (!messages.includes(message)) messages.push(message);
  }
  // Each side was capped alone, so merging two full windows would put twice the cap on a row.
  const overflow = Math.max(0, messages.length - BUFFER_CAP);
  return {
    messages: overflow > 0 ? messages.slice(0, BUFFER_CAP) : messages,
    fatal: first.fatal || second.fatal,
    dropped: first.dropped + second.dropped + overflow,
  };
}

// A healthy component's report stays byte-identical to one with no page-error field at all.
export function hasPageErrors(drain: PageErrorDrain | undefined): boolean {
  return drain !== undefined && (drain.messages.length > 0 || drain.dropped > 0);
}

// The dropped count is promoted to a visible entry instead of a silently missing one.
export function renderDrain(drain: PageErrorDrain): string[] {
  return drain.dropped > 0
    ? [...drain.messages, `(+${drain.dropped} more dropped)`]
    : [...drain.messages];
}

// An ESM temporal-dead-zone error: not a component defect and not a timeout.
const TDZ_PAGE_ERROR = /Cannot access '([^']+)' before initialization/;

export function tdzCycleNote(capture: PageErrorCapture): string | undefined {
  for (const error of capture.errors) {
    const match = TDZ_PAGE_ERROR.exec(error);
    if (!match) continue;
    const lead = `${match[1]} was read before its module finished initializing`;
    return wasImportCycleReported()
      ? `${lead}: an import cycle the generated entry enters from the component's own file, ` +
          "rather than where the application enters it (see the import-cycle warning above). Add " +
          "a 120fps.setup.tsx, or pass --wrap, that imports this package's own root module first."
      : `${lead} (a temporal dead zone) — possibly an import cycle this run's preflight did not ` +
          "report, or a module-scope read of a binding initialized later in the same file.";
  }
  return undefined;
}

// One summary text under two lead sentences, so a hang and an early throw read differently.
function errorDetailBlock(capture: PageErrorCapture): string {
  return capture.errors.length > 0
    ? ` Page errors:\n${capture.summary()}`
    : " No page errors were captured.";
}

// The environment-file remedy answers only these three shapes; anything else is a guess.
const ENV_VARIABLE_PATTERNS = [
  /\bprocess\.env\.[A-Za-z_$][\w$]*/,
  /\bimport\.meta\.env\.[A-Za-z_$][\w$]*/,
  /\benv(?:ironment)? variable/i,
];

export function namesEnvironmentVariable(text: string): boolean {
  return ENV_VARIABLE_PATTERNS.some((pattern) => pattern.test(text));
}

function envRemedyFor(capture: PageErrorCapture, remedyLine: string | undefined): string {
  if (!remedyLine) return "";
  return capture.errors.some(namesEnvironmentVariable) ? `\n${remedyLine}` : "";
}

// `remedyLine` is appended only when the capture holds an error; a silent hang gets no guess.
export function enrichTimeoutError(
  err: unknown,
  capture: PageErrorCapture,
  context: string,
  remedyLine?: string,
): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const isTimeout = base.name === "TimeoutError" || base.message.includes("Timeout");
  if (!isTimeout) return base;

  const remedy = envRemedyFor(capture, remedyLine);
  // A temporal-dead-zone error has a known cause, so the env-file line would read as a guess.
  const cycle = tdzCycleNote(capture);
  return new Error(
    `${context} did not become ready within timeout.${errorDetailBlock(capture)}` +
      (cycle ? `\n${cycle}` : remedy),
    { cause: err },
  );
}

// Best-effort: a minified stack yields no module name and the caller falls back to the text.
const SOURCE_FRAME_PATTERN = /([^\s()]+\.(?:tsx?|jsx?|mjs|cjs|vue))(?=:\d+(?::\d+)?|\)|$)/;

export function extractThrowingModule(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  for (const line of stack.split("\n")) {
    const match = line.match(SOURCE_FRAME_PATTERN);
    if (!match) continue;
    const segments = match[1].split(/[/\\]/);
    const name = segments[segments.length - 1];
    if (name) return name;
  }
  return undefined;
}

// Leads with the page error, since "did not become ready" reads as a perf problem.
export function buildFatalPageErrorMessage(
  fatal: FatalPageError,
  capture: PageErrorCapture,
  context: string,
  envRemedyLine?: string,
): Error {
  const moduleName = extractThrowingModule(fatal.stack);
  const modulePrefix = moduleName ? `${moduleName}: ` : "";
  const remedy = envRemedyFor(capture, envRemedyLine);
  return new Error(
    `${context} failed before it became ready: ${modulePrefix}${fatal.message}.${errorDetailBlock(capture)}${remedy}`,
  );
}

// `buildEnvRemedyLine` runs only once a fatal won the race, never on the healthy path.
export async function waitForReadyOrFatal(
  waitForReady: () => Promise<unknown>,
  capture: PageErrorCapture,
  context: string,
  buildEnvRemedyLine?: () => string | undefined,
): Promise<void> {
  let fatal: FatalPageError | undefined;
  const fatalSignal = capture.waitForFatal().then((f) => {
    fatal = f;
  });
  try {
    await Promise.race([waitForReady(), fatalSignal]);
  } catch (err) {
    // A fatal that arrived before this registered a waiter still leads over the timeout.
    const delivered = fatal ?? capture.capturedFatal();
    if (delivered) {
      throw buildFatalPageErrorMessage(delivered, capture, context, buildEnvRemedyLine?.());
    }
    // A timeout that captured nothing has nothing to attribute a remedy to.
    const remedyLine = capture.errors.length > 0 ? buildEnvRemedyLine?.() : undefined;
    throw enrichTimeoutError(err, capture, context, remedyLine);
  }
  if (fatal) {
    throw buildFatalPageErrorMessage(fatal, capture, context, buildEnvRemedyLine?.());
  }
}

// Structural subset of Page, so the wrapper is testable without a browser.
interface NavigablePage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
}

// The navigation itself can time out, and it is the half that carries no diagnostics.
export async function gotoWithErrorContext(
  page: NavigablePage,
  url: string,
  capture: PageErrorCapture,
  context: string,
  options?: Record<string, unknown>,
): Promise<void> {
  try {
    capture.resetCapturedFatal();
    await page.goto(url, options);
  } catch (err) {
    throw enrichTimeoutError(err, capture, context);
  }
}

// "delta" is measureStandardPropDeltas's own mount/rerender calls; its remedy flag differs.
export type MeasurementPhase = "mount" | "rerender" | "explore" | "attribution" | "delta";

export interface PhaseContext {
  phase: MeasurementPhase;
  comboIndex?: number;
  component?: string;
}

export const HARNESS_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with --no-attribution, a shorter --explore-budget, or fewer --samples.";

// --no-attribution cannot remedy a stall in the delta pass; --no-deltas skips that path.
export const DELTA_PHASE_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with --no-deltas, a shorter --explore-budget, or fewer --samples.";

// --no-attribution and --explore-budget govern other passes, not measureRerender's workload.
export const RERENDER_PHASE_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with fewer --samples or a lower --max-combos.";

// An explore stall is the interaction budget, not the tracing pass --no-attribution disables.
export const EXPLORE_PHASE_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with a shorter --explore-budget or fewer --samples.";

function stallHintForPhase(phase: MeasurementPhase): string {
  if (phase === "delta") return DELTA_PHASE_STALL_HINT;
  if (phase === "rerender") return RERENDER_PHASE_STALL_HINT;
  if (phase === "explore") return EXPLORE_PHASE_STALL_HINT;
  return HARNESS_STALL_HINT;
}

// Everything else keeps its own message and gets no hint: a wrong hint costs more than none.
const STALL_SIGNATURES = [
  /Tracing\.tracingComplete timed out/i,
  /frame starvation/i,
  /Target (page|closed|crashed)/i,
];

const PHASE_TAGGED = Symbol.for("120fps.phaseTagged");

export function describePhase(context: PhaseContext): string {
  const combo = context.comboIndex !== undefined ? ` on combo ${context.comboIndex}` : "";
  const component = context.component ? ` of ${context.component}` : "";
  return `${context.phase} phase failed${combo}${component}`;
}

// The original message survives inside the enriched one, so message matchers keep working.
export function enrichPhaseError(err: unknown, context: PhaseContext): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  if ((base as unknown as Record<symbol, unknown>)[PHASE_TAGGED]) return base;

  const hint = STALL_SIGNATURES.some((pattern) => pattern.test(base.message))
    ? ` ${stallHintForPhase(context.phase)}`
    : "";
  const enriched = new Error(`${describePhase(context)}: ${base.message}${hint}`, { cause: err });
  (enriched as unknown as Record<symbol, unknown>)[PHASE_TAGGED] = true;
  return enriched;
}

// PHASE_TAGGED makes a second enrichPhaseError call a no-op, so `.cause` is re-enriched.
export function retagPhaseError(err: unknown, context: PhaseContext): Error {
  const cause = err instanceof Error ? err.cause : undefined;
  return enrichPhaseError(cause ?? err, context);
}
