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

export interface PageErrorCapture {
  errors: string[];
  summary(): string;
  drain(): PageErrorDrain;
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

export function attachPageErrorCapture(page: Page): PageErrorCapture {
  // Two buckets over one event stream. The session bucket feeds
  // `enrichTimeoutError` and spans the whole run; the segment bucket is reset
  // on every drain so each combo gets its own dedupe and its own cap, and a
  // combo late in a noisy run is never starved by earlier distinct messages.
  const session = createBucket();
  const segment = createBucket();
  let segmentFatal = false;

  page.on("pageerror", (err) => {
    session.record(err.message);
    segment.record(err.message);
    segmentFatal = true;
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    session.record(msg.text());
    segment.record(msg.text());
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

export function enrichTimeoutError(
  err: unknown,
  capture: PageErrorCapture,
  context: string,
): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const isTimeout = base.name === "TimeoutError" || base.message.includes("Timeout");
  if (!isTimeout) return base;

  const detail = capture.errors.length > 0
    ? ` Page errors:\n${capture.summary()}`
    : " No page errors were captured.";
  return new Error(`${context} did not become ready within timeout.${detail}`, { cause: err });
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
