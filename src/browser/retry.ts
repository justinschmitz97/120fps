export const CONTEXT_RETRY_WARNING =
  "the dev server reloaded the page mid-measurement; the affected sample was retried once";

// Its own sentence: only one of `isContextLostError`'s signatures is a dev-server reload.
export const TRACING_STALL_RETRY_WARNING =
  "the cost-attribution trace stalled (Tracing.tracingComplete never arrived); the affected sample " +
  "was retried once against a fresh CDP session";

export const TARGET_CLOSED_RETRY_WARNING =
  "the browser target closed mid-measurement; the affected sample was retried once after re-entering " +
  "the harness page";

export function contextRetryWarningFor(err: unknown): string {
  if (isTracingTimeoutError(err)) return TRACING_STALL_RETRY_WARNING;
  if (isTargetClosedError(err)) return TARGET_CLOSED_RETRY_WARNING;
  return CONTEXT_RETRY_WARNING;
}

// Exhausting the shared budget means the pattern kept recurring, which points at the environment.
export const RETRY_BUDGET_EXHAUSTED_NOTE =
  " The context-retry budget is exhausted: repeated dev-server reloads (environment), not the " +
  "component, are the likely cause.";

// Naming reloads for a run that never reloaded sends the reader at the wrong subsystem.
export const TRACING_BUDGET_EXHAUSTED_NOTE =
  " The context-retry budget is exhausted: the cost-attribution trace kept stalling (environment), " +
  "not the component.";

export const TARGET_CLOSED_BUDGET_EXHAUSTED_NOTE =
  " The context-retry budget is exhausted: the browser target kept closing (environment), not the " +
  "component.";

export function retryBudgetExhaustedNoteFor(err: unknown): string {
  if (isTracingTimeoutError(err)) return TRACING_BUDGET_EXHAUSTED_NOTE;
  if (isTargetClosedError(err)) return TARGET_CLOSED_BUDGET_EXHAUSTED_NOTE;
  return RETRY_BUDGET_EXHAUSTED_NOTE;
}

// Vite's dependency optimizer full-reloads the page, taking the context and `__120fps` together.
const CONTEXT_LOST = [
  /Execution context was destroyed/i,
  /Cannot read properties of undefined \(reading '(mount|unmount|rerender|mountWrapperOnly|getContainer)'\)/i,
  /__120fps.*(undefined|not a function)/i,
  // Retryable only because `enter` replaces the CDP session a wedged trace pipeline leaves.
  /Tracing\.tracingComplete timed out/i,
  /Target (page|closed|crashed)/i,
];


// Unretried, one 10s fence timeout kills the pass; matches `rafFence`'s own thrown text.
const FRAME_STARVATION_PATTERN = /frame starvation/i;

export function isFrameStarvationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return FRAME_STARVATION_PATTERN.test(message);
}

// Not shared: CONTEXT_LOST is a disjoint retry layer; page-errors.ts's list drives hint selection.
const TRACING_TIMEOUT_PATTERN = /Tracing\.tracingComplete timed out/i;
const TARGET_CLOSED_PATTERN = /Target (page|closed|crashed)/i;

export function isTracingTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return TRACING_TIMEOUT_PATTERN.test(message);
}

export function isTargetClosedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return TARGET_CLOSED_PATTERN.test(message);
}

// No abort signal exists here, so a teardown-closed target reads the same as a crashed one.
type StallKind = "starvation" | "tracing-timeout" | "target-closed";

function classifyStall(err: unknown): StallKind | undefined {
  if (isFrameStarvationError(err)) return "starvation";
  if (isTracingTimeoutError(err)) return "tracing-timeout";
  if (isTargetClosedError(err)) return "target-closed";
  return undefined;
}

export const MAX_FRAME_STARVATION_RETRIES = 2;

export const frameStarvationRetryWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: rAF fence starved for frames; retrying against a freshly re-entered harness session`;

export const frameStarvationDegradedWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: measurement did not complete after ${MAX_FRAME_STARVATION_RETRIES} retries ` +
  `(frame starvation); omitted from the report rather than failing the run`;

export const tracingTimeoutRetryWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: cost-attribution trace stalled (Tracing.tracingComplete timed out); ` +
  `retrying against a freshly re-entered harness session`;

export const tracingTimeoutDegradedWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: measurement did not complete after ${MAX_FRAME_STARVATION_RETRIES} retries ` +
  `(tracing timeout); omitted from the report rather than failing the run`;

export const targetClosedRetryWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: browser target closed mid-measurement; retrying against a freshly re-entered harness session`;

export const targetClosedDegradedWarning = (comboIndex: number): string =>
  `combo ${comboIndex}: measurement did not complete after ${MAX_FRAME_STARVATION_RETRIES} retries ` +
  `(target closed); omitted from the report rather than failing the run`;

function retryWarningFor(kind: StallKind, comboIndex: number): string {
  if (kind === "tracing-timeout") return tracingTimeoutRetryWarning(comboIndex);
  if (kind === "target-closed") return targetClosedRetryWarning(comboIndex);
  return frameStarvationRetryWarning(comboIndex);
}

function degradedWarningFor(kind: StallKind, comboIndex: number): string {
  if (kind === "tracing-timeout") return tracingTimeoutDegradedWarning(comboIndex);
  if (kind === "target-closed") return targetClosedDegradedWarning(comboIndex);
  return frameStarvationDegradedWarning(comboIndex);
}

// On exhaustion this returns undefined instead of throwing, so one stalled combo is omitted.
export async function withFrameStarvationRetry<T>(
  comboIndex: number,
  enter: () => Promise<void>,
  body: () => Promise<T>,
  onWarning?: (warning: string) => void,
): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await body();
    } catch (err) {
      const kind = classifyStall(err);
      if (!kind) throw err;
      if (attempt >= MAX_FRAME_STARVATION_RETRIES) {
        onWarning?.(degradedWarningFor(kind, comboIndex));
        return undefined;
      }
      onWarning?.(retryWarningFor(kind, comboIndex));
      try {
        await enter();
      } catch (enterErr) {
        // `enter` runs its own settle fence; a stall there must not escape this budget.
        const enterKind = classifyStall(enterErr);
        if (!enterKind) throw enterErr;
        if (attempt >= MAX_FRAME_STARVATION_RETRIES) {
          onWarning?.(degradedWarningFor(enterKind, comboIndex));
          return undefined;
        }
        onWarning?.(retryWarningFor(enterKind, comboIndex));
      }
    }
  }
}

// Warmup calls hit the same fence as the sample loops but sit outside their retry wrapper.
export async function withWarmupRetry(
  comboIndex: number,
  enter: () => Promise<void>,
  warmup: () => Promise<void>,
  retryBudget: RetryBudget,
  onWarning?: (warning: string) => void,
): Promise<boolean> {
  const completed = await withFrameStarvationRetry(
    comboIndex,
    enter,
    async () => {
      await withContextRetry(enter, warmup, { onRetry: onWarning, budget: retryBudget });
      return true as const;
    },
    onWarning,
  );
  return completed === true;
}

export function isContextLostError(err: unknown): boolean {
  const message =
    typeof err === "string" ? err : err instanceof Error ? err.message : "";
  if (!message) return false;
  return CONTEXT_LOST.some((pattern) => pattern.test(message));
}

export interface RetryBudget {
  remaining: number;
}

export const DEFAULT_RETRY_BUDGET = 2;

// A handful per pass, never one per sample: losing context every sample is a broken environment.
export function createRetryBudget(max = DEFAULT_RETRY_BUDGET): RetryBudget {
  return { remaining: max };
}

// One retry per call, never a loop: losing the context twice for one sample is a real failure.
export async function withContextRetry<T>(
  enter: () => Promise<void>,
  body: () => Promise<T>,
  options?: { onRetry?: (warning: string) => void; budget?: RetryBudget },
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (!isContextLostError(err)) throw err;
    const budget = options?.budget;
    if (budget) {
      if (budget.remaining <= 0) {
        const original = err instanceof Error ? err : new Error(String(err));
        throw new Error(original.message + retryBudgetExhaustedNoteFor(err), { cause: err });
      }
      budget.remaining--;
    }
    // The warning names the signature that actually fired.
    options?.onRetry?.(contextRetryWarningFor(err));
    await enter();
    return await body();
  }
}
