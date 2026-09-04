import type { Page } from "playwright";
import { wasImportCycleReported } from "../shared/index.js";

const BUFFER_CAP = 20;

// Everything recorded between two `drain()` calls. `fatal` is true when at
// least one of them was an uncaught page exception rather than console output:
// React and Vue both log dev warnings through console.error, and a verdict must
// never turn on those.
export interface PageErrorDrain {
  messages: string[];
  fatal: boolean;
  dropped: number;
}

// A fatal (uncaught page exception) is unambiguous evidence the
// harness will never become ready — unlike a console.error, which stays
// bucket-only and non-fatal. `stack` is captured here specifically, even
// though `record()`'s bucket stays message-keyed (dedup/cap behavior at
// `createBucket` is untouched): only the fail-fast path needs it, to
// best-effort name the throwing module.
export interface FatalPageError {
  message: string;
  stack?: string;
}

export interface PageErrorCapture {
  errors: string[];
  summary(): string;
  drain(): PageErrorDrain;
  // Resolves on the next pageerror event after this call — first hit wins,
  // matching this codebase's existing precedent (harness.ts, project-model.ts).
  // A caller races this against its own readiness wait; a healthy run simply
  // never resolves it.
  waitForFatal(): Promise<FatalPageError>;
  // The first uncaught page exception of the current
  // segment, whether or not a waiter existed when it arrived. A module that
  // throws during evaluation throws before the readiness wait is even set up;
  // read on the failure path so that error, not the timeout, leads the report.
  capturedFatal(): FatalPageError | undefined;
  // A new document ends the old document's fatal. Without this,
  // an error captured after the last drain leads the NEXT segment's readiness
  // timeout and suppresses the true "did not become ready" wording.
  resetCapturedFatal(): void;
}

// Retention is by distinct message: repeats of one noisy message must not
// evict the one real error under it. `order` holds first-seen order, `counts`
// the repeat count per distinct message; the cap applies to the number of
// distinct entries, not raw events.
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

// A synthesized string placeholder ("test",
// props/synthesize.ts) landed in a plain `<img src>` relative-resolves
// against the page's own URL, which *is* the harness's Vite-served root —
// producing a same-origin, bare, extension-less 404 the harness caused, not
// the component. Deliberately narrow: every legitimate asset the harness
// serves (the component's own source, Vite's own paths, a real CSS/JS/image
// import) carries either a file extension or a directory prefix, so a
// genuine CSS-import 404 (what these listeners exist to catch) is never
// excluded by this rule.
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
  return !match[1].includes(".");
}

// Playwright renders a console call as the format
// string followed by every argument's preview, joined by a space, and
// substitutes nothing — so React's `Warning: %s is invalid` reached the report
// with the `%s` intact and the value stranded at the end of the line. The same
// previews arrive through `msg.args()`, which is what the browser's own
// console would have formatted with.
//
// `text` is the fallback for a message that carries no arguments at all;
// `args[0]` is the format string and the rest fill its placeholders, in order.
// A placeholder with no argument left stays literal, `%%` collapses to one
// percent sign and consumes nothing, `%c` consumes its CSS argument and prints
// nothing, and arguments the format never used are appended, exactly as a
// browser console renders them.
export function substituteConsoleFormat(text: string, args: string[]): string {
  const format = args[0];
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
  // Two buckets over one event stream. The session bucket feeds
  // `enrichTimeoutError` and spans the whole run; the segment bucket is reset
  // on every drain so each combo gets its own dedupe and its own cap, and a
  // combo late in a noisy run is never starved by earlier distinct messages.
  const session = createBucket();
  const segment = createBucket();
  let segmentFatal = false;
  // Segment-scoped, reset by every drain: a combo never inherits the fatal a
  // previous combo already reported.
  let capturedFatal: FatalPageError | undefined;
  // Fresh per `waitForFatal()` call, so a caller that already
  // missed one fatal event (e.g. from an earlier phase) only ever gets
  // notified of the NEXT one, never a stale replay.
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
  // A CSS import that 404s, or a preprocessor that answers 500, kills module
  // evaluation with no exception of its own: the readiness gate just never
  // resolves. Neither case is proof a render crashed, so neither sets `fatal`,
  // matching console.error's dev-warning noise.
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

// Two windows over the same page, merged into one per-combo record: the mount
// pass and the rerender pass, or a driven attempt and its vsync re-measurement.
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
  // Each side was capped on its own, so merging two full windows would put
  // twice the cap on one row. The cap is what bounds the output, so it applies
  // to the merged record too and the overflow joins the dropped count.
  const overflow = Math.max(0, messages.length - BUFFER_CAP);
  return {
    messages: overflow > 0 ? messages.slice(0, BUFFER_CAP) : messages,
    fatal: first.fatal || second.fatal,
    dropped: first.dropped + second.dropped + overflow,
  };
}

// A drain with nothing in it is not attached anywhere: a healthy component's
// report must be byte-identical to what it was before this existed.
export function hasPageErrors(drain: PageErrorDrain | undefined): boolean {
  return drain !== undefined && (drain.messages.length > 0 || drain.dropped > 0);
}

// The messages as a report carries them, with the dropped count promoted to a
// visible entry rather than a silently missing one.
export function renderDrain(drain: PageErrorDrain): string[] {
  return drain.dropped > 0
    ? [...drain.messages, `(+${drain.dropped} more dropped)`]
    : [...drain.messages];
}

// Shared by enrichTimeoutError and buildFatalPageErrorMessage below: the same
// capture.summary() text under two different lead sentences, so a genuine
// hang (nothing captured, timeout fires) and an early fatal throw (something
// captured almost instantly) read as two different failures, which they are.
// "Cannot access 'DropdownMenu' before initialization"
// is an ESM temporal-dead-zone error, not a component defect and not a
// timeout. The preflight import-cycle warning printed above says which cycle;
// this says why the failure the user is looking at is that cycle.
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

function errorDetailBlock(capture: PageErrorCapture): string {
  return capture.errors.length > 0
    ? ` Page errors:\n${capture.summary()}`
    : " No page errors were captured.";
}

// "Unable to determine current node version" was given
// an environment-file remedy, a guess about an error that names no environment
// variable. These three shapes are what that remedy answers for.
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

// `remedyLine` is the same line buildFatalPageErrorMessage
// already appends. It reaches this branch because the readiness wait's own
// timeout usually beats the fatal signal, which left
// the refusal a user can act on with no next step at all. Appended only when
// the capture actually holds a page error: with nothing captured, a suggestion
// about environment files would be a guess about a silent hang.
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
  // A temporal-dead-zone error has a known cause, so it is attributed
  // instead of speculated about; the env-file line would read as a guess next
  // to it and is dropped for that one shape.
  const cycle = tdzCycleNote(capture);
  return new Error(
    `${context} did not become ready within timeout.${errorDetailBlock(capture)}` +
      (cycle ? `\n${cycle}` : remedy),
    { cause: err },
  );
}

// A file with a JS/TS/Vue extension, the first such frame in the
// stack (the message line itself is skipped naturally: it does not carry a
// `:line:col` suffix). Best-effort suspect-naming in the same spirit as
// `detectLocalProviderModule` (project/preflight.ts) — "the point is to name a
// suspect, not to prove it": a minified or source-mapless stack yields no
// module name, and the caller falls back to the page-error text alone.
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

// The fail-fast counterpart to enrichTimeoutError: leads with the page error
// itself instead of "did not become ready within timeout" — a perf-sounding
// headline for a cause that is not a perf issue.
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

// Races a caller's own readiness wait against the
// fatal signal. When the fatal signal wins, throws immediately instead of
// waiting out the remaining timeout; when readiness itself rejects (a genuine
// hang) with no fatal signal, falls back to enrichTimeoutError unchanged.
// `buildEnvRemedyLine` is called lazily, only once a fatal signal has
// actually won the race — never on the healthy path or a plain timeout.
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
    // The readiness wait rejecting first does not mean no fatal error
    // arrived — in practice the fatal signal usually arrives first, seconds
    // earlier, and the race is decided by whichever promise settles first. A
    // fatal signal that is already here still leads; otherwise the timeout
    // carries the remedy.
    // The throw may instead have arrived before this call registered a
    // waiter (a module that fails during evaluation always does), in which case
    // the capture is holding it and it still leads the report.
    const delivered = fatal ?? capture.capturedFatal();
    if (delivered) {
      throw buildFatalPageErrorMessage(delivered, capture, context, buildEnvRemedyLine?.());
    }
    // Still lazy: a timeout that captured nothing has nothing to attribute a
    // remedy to, so the callback is not even called for it.
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

// The navigation itself, not only the readiness gate that follows it, can be
// what times out: and it is the half that carries no diagnostics of its own.
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

// "delta" is the prop-delta pass's own
// extra mount/rerender calls (pipeline/modes/matrix.ts's measureStandardPropDeltas) —
// distinct from the ordinary "mount"/"rerender" phases those same
// measure.ts functions tag themselves with, because the right remediation
// flag differs (see stallHintForPhase below) even though the underlying
// measurement code is shared.
export type MeasurementPhase = "mount" | "rerender" | "explore" | "attribution" | "delta";

export interface PhaseContext {
  phase: MeasurementPhase;
  comboIndex?: number;
  component?: string;
}

export const HARNESS_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with --no-attribution, a shorter --explore-budget, or fewer --samples.";

// --no-attribution only disables cost-attribution tracing, a pass
// the delta measurement never runs — it cannot be the remedy for a stall
// inside the delta pass's own mount/rerender calls. --no-deltas is the flag
// that actually skips that code path.
export const DELTA_PHASE_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with --no-deltas, a shorter --explore-budget, or fewer --samples.";

// The same false-remediation problem the delta phase had also reaches the
// rerender phase directly, not only through the delta pass's retagging: a
// stall there could still surface with the delta-phase hint, wrongly
// suggesting `--no-attribution`.
// --no-attribution only disables analysis/react-profiler.ts's separate
// cost-attribution pass (the "attribution" phase); it does not touch
// anything measureRerender does. --samples and --max-combos are the flags
// that actually shrink the rerender pass's own workload (measure.ts).
// --explore-budget is left out for the same reason --no-attribution is: it
// governs analysis/explorer.ts's interaction exploration, not the rerender
// pass.
export const RERENDER_PHASE_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with fewer --samples or a lower --max-combos.";

// The explore phase's `--no-attribution` advice, measured against the
// failing component, would produce an identical failure — the stall is the
// exploration's own interaction budget (20 clicks
// against a Radix portal whose `pointer-events: none` times each one out),
// not the tracing pass. The two flags that really bound it are the budget and
// the sample count.
export const EXPLORE_PHASE_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with a shorter --explore-budget or fewer --samples.";

function stallHintForPhase(phase: MeasurementPhase): string {
  if (phase === "delta") return DELTA_PHASE_STALL_HINT;
  if (phase === "rerender") return RERENDER_PHASE_STALL_HINT;
  if (phase === "explore") return EXPLORE_PHASE_STALL_HINT;
  return HARNESS_STALL_HINT;
}

// Failures whose cause is the page never going idle. Everything else keeps its
// own message and gets no hint: a wrong hint costs more than no hint.
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

// The original message survives inside the enriched one, so `isContextLostError`
// and every other message matcher keeps working on the wrapped error.
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

// A caller whose own context is more specific than the phase an
// inner measurement call already tagged (the delta pass's own extra
// mount/rerender calls, tagged "mount"/"rerender" by measure.ts) cannot
// just call enrichPhaseError again — its PHASE_TAGGED guard makes a second
// call on an already-enriched error a no-op. Re-enriches `.cause` instead,
// which enrichPhaseError always sets to the untagged original error, so the
// stall-signature check and hint selection run fresh under the new phase.
export function retagPhaseError(err: unknown, context: PhaseContext): Error {
  const cause = err instanceof Error ? err.cause : undefined;
  return enrichPhaseError(cause ?? err, context);
}
