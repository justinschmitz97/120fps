import type { Page } from "playwright";

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

// M79 gap 3b: a fatal (uncaught page exception) is unambiguous evidence the
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

// M83 #2 (element-plus-F3): a synthesized string placeholder ("test",
// src/prop-gen-values.ts) landed in a plain `<img src>` relative-resolves
// against the page's own URL, which *is* the harness's Vite-served root —
// producing a same-origin, bare, extension-less 404 the harness caused, not
// the component. Deliberately narrow: every legitimate asset the harness
// serves (the component's own source, Vite's own paths, a real CSS/JS/image
// import) carries either a file extension or a directory prefix, so a
// genuine CSS-import 404 (what M70 added these listeners to catch) is never
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

export function attachPageErrorCapture(page: Page, harnessDirName?: string): PageErrorCapture {
  // Two buckets over one event stream. The session bucket feeds
  // `enrichTimeoutError` and spans the whole run; the segment bucket is reset
  // on every drain so each combo gets its own dedupe and its own cap, and a
  // combo late in a noisy run is never starved by earlier distinct messages.
  const session = createBucket();
  const segment = createBucket();
  let segmentFatal = false;
  // M79 gap 3b: fresh per `waitForFatal()` call, so a caller that already
  // missed one fatal event (e.g. from an earlier phase) only ever gets
  // notified of the NEXT one, never a stale replay.
  let fatalWaiters: Array<(fatal: FatalPageError) => void> = [];

  page.on("pageerror", (err) => {
    session.record(err.message);
    segment.record(err.message);
    segmentFatal = true;
    if (fatalWaiters.length > 0) {
      const waiters = fatalWaiters;
      fatalWaiters = [];
      const fatal: FatalPageError = { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
      for (const resolve of waiters) resolve(fatal);
    }
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    session.record(msg.text());
    segment.record(msg.text());
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
      return result;
    },
    waitForFatal() {
      return new Promise<FatalPageError>((resolve) => {
        fatalWaiters.push(resolve);
      });
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
function errorDetailBlock(capture: PageErrorCapture): string {
  return capture.errors.length > 0
    ? ` Page errors:\n${capture.summary()}`
    : " No page errors were captured.";
}

export function enrichTimeoutError(
  err: unknown,
  capture: PageErrorCapture,
  context: string,
): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const isTimeout = base.name === "TimeoutError" || base.message.includes("Timeout");
  if (!isTimeout) return base;

  return new Error(`${context} did not become ready within timeout.${errorDetailBlock(capture)}`, { cause: err });
}

// M79 gap 3b: a file with a JS/TS/Vue extension, the first such frame in the
// stack (the message line itself is skipped naturally: it does not carry a
// `:line:col` suffix). Best-effort suspect-naming in the same spirit as
// `detectLocalProviderModule` (preflight.ts) — "the point is to name a
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
  const remedy = envRemedyLine ? `\n${envRemedyLine}` : "";
  return new Error(
    `${context} failed before it became ready: ${modulePrefix}${fatal.message}.${errorDetailBlock(capture)}${remedy}`,
  );
}

// M79 gap 3b (taxonomy-F1): races a caller's own readiness wait against the
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
    throw enrichTimeoutError(err, capture, context);
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
    await page.goto(url, options);
  } catch (err) {
    throw enrichTimeoutError(err, capture, context);
  }
}

export type MeasurementPhase = "mount" | "rerender" | "explore" | "attribution";

export interface PhaseContext {
  phase: MeasurementPhase;
  comboIndex?: number;
  component?: string;
}

export const HARNESS_STALL_HINT =
  "A Worker, a long-lived timer or a running animation can keep the page busy so the trace " +
  "never completes; retry with --no-attribution, a shorter --explore-budget, or fewer --samples.";

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
    ? ` ${HARNESS_STALL_HINT}`
    : "";
  const enriched = new Error(`${describePhase(context)}: ${base.message}${hint}`, { cause: err });
  (enriched as unknown as Record<symbol, unknown>)[PHASE_TAGGED] = true;
  return enriched;
}
