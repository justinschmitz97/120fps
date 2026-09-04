export const CONTEXT_RETRY_WARNING =
  "the dev server reloaded the page mid-measurement; the affected sample was retried once";

// `isContextLostError` matches three signatures and only
// one of them is a dev-server reload. A tracing stall would print "the dev
// server reloaded the page mid-measurement" for a reload that did not
// happen, and the reader would have no way to tell which of the two had
// occurred.
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

// Promoted to user-facing text: the retry above absorbs one reload, but
// exhausting the shared budget means the pattern kept recurring across the
// run: that points at the environment, not the component under test.
export const RETRY_BUDGET_EXHAUSTED_NOTE =
  " The context-retry budget is exhausted: repeated dev-server reloads (environment), not the " +
  "component, are the likely cause.";

// The same distinction on the exhaustion path. Naming reloads for a
// run that never reloaded sends a reader at the dev server instead of at the
// trace pipeline.
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

// Vite's dependency optimizer can full-reload the page while a sample is in
// flight. Two signatures, one cause: the evaluation context and the control API
// living on it disappear together.
//
// A tracing timeout leaves the CDP session wedged: the next `Tracing.start`
// answers "already been started". It is retryable only because `enter`
// replaces the session rather than merely re-navigating.
const CONTEXT_LOST = [
  /Execution context was destroyed/i,
  /Cannot read properties of undefined \(reading '(mount|unmount|rerender|mountWrapperOnly|getContainer)'\)/i,
  /__120fps.*(undefined|not a function)/i,
  /Tracing\.tracingComplete timed out/i,
  /Target (page|closed|crashed)/i,
];


// A frame-starvation failure with no retry kills the whole pass: one 10s
// timeout throws, uncaught until the CLI's top-level handler. Matches
// `rafFence`'s own thrown text.
const FRAME_STARVATION_PATTERN = /frame starvation/i;

export function isFrameStarvationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return FRAME_STARVATION_PATTERN.test(message);
}

// A closed target is
// exactly as recoverable as a starved fence (both are fixed by replacing the
// CDP session via `enter`), but only frame starvation was guarded here.
// `Tracing.tracingComplete timed out` fails the same way (a wedged CDP
// trace pipeline, also fixed by `enter` replacing the session). Patterns
// mirror `STALL_SIGNATURES` in page-errors.ts and the two matching entries
// already in this file's own `CONTEXT_LOST` list above -- kept as separate
// literals rather than shared, since page-errors.ts's list also carries
// hint-selection concerns this module has no reason to depend on, and
// `CONTEXT_LOST` is a disjoint retry layer (`withContextRetry`) this one
// composes around, not merges into.
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

// The three signatures `withFrameStarvationRetry` recovers from, sharing one
// bounded budget (`MAX_FRAME_STARVATION_RETRIES`). No shutdown/abort signal
// is observable anywhere in this codebase (no SIGINT/SIGTERM handler and no
// AbortController threaded through measurement), so a target closed by a
// genuine process teardown cannot be distinguished, from here, from one
// closed by a transient crash. The small fixed budget is the safeguard
// either way: a real teardown costs at most two quick, already-failing
// attempts before this degrades the combo and returns, rather than hanging
// or looping.
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

// A bounded, disclosed retry for failure signatures the fence itself
// (a closed target or a wedged trace pipeline, as above) has no
// recovery from — orthogonal to `withContextRetry` (a disjoint signature
// list, its own escalate-and-throw behavior on exhaustion, unchanged by
// this). On exhaustion this does NOT throw: it discloses and returns
// `undefined`, so the caller can omit the one combo that stalled rather
// than failing every other combo in the same pass. `enter` is the same
// session-refresh (`refreshCdpSession` + `enterHarness`) the context-lost
// retry already uses — it replaces the CDP session the frame pump reads on
// every loop iteration, which is the most plausible recovery path for all
// three signatures alike.
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
        // enter() re-runs enterHarness's own
        // independent style-settle fence (measure.ts's settleStyles). Left
        // unguarded, a stall there would escape this function entirely -- the
        // exact failure this retry exists to prevent, relocated one frame
        // up. Counts against the same bounded budget as a body() stall
        // (this iteration already consumed one `attempt`) and falls through
        // to retry body() on the next iteration rather than throwing; that
        // retry's own stall, if any, degrades normally through the branch
        // above once the budget is exhausted.
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

// `measureRerender`'s and `measureMount`'s warmup calls
// (`mountAndWait`, `rerenderAndTrace`, `runMountUnmount`) touch the same
// rafFence-guarded page as the sample loops but run directly, outside any
// retry wrapper -- without this, whichever combo happens to starve during
// its warmup (rather than during a sample) would escape retry/degrade
// entirely and take the whole pass down. `withWarmupRetry` closes that gap
// with the identical
// composition the sample loops already use (`withFrameStarvationRetry`
// around `withContextRetry`, sharing the pass's `retryBudget`), so a
// warmup-time stall degrades the combo exactly like a sample-time one
// instead of escaping unguarded.
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

// One pass gets a handful of retries, not one per sample. A reload mid-sample
// is a race worth surviving; a machine losing the context on every sample is a
// broken environment, and retrying through it turns a fast failure into a slow
// one while starving whatever else is running.
export function createRetryBudget(max = DEFAULT_RETRY_BUDGET): RetryBudget {
  return { remaining: max };
}

// One retry per call, not a loop: losing the context twice for the same sample
// is a real failure.
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
