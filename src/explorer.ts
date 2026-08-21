import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import { extractProps } from "./prop-gen.js";
import { generateCombinations, selectRepresentativeCombos } from "./prop-gen-values.js";
import {
  discoverInteractions,
  type InteractionDescriptor,
  type DiscoverOptions,
} from "./discovery.js";
import {
  resolveStressPattern,
  executeStressPattern,
  findAriaGroupSiblings,
  countPatternEvents,
  type StressPatternRun,
} from "./stress-patterns.js";
import {
  applyWrapperViewport,
  collectTrace,
  computeMedian,
  computeP95,
  parseTraceDuration,
  settleStyles,
  reportFontSettle,
  tryCollectGarbage,
  suspendThrottle,
  withContextRetry,
  withFrameStarvationRetry,
  createRetryBudget,
  createPhaseTracker,
  refreshCdpSession,
  type CdpHolder,
  type RetryBudget,
  HARNESS_NAV_WAIT,
  type TraceEvent,
} from "./measure.js";
import {
  attachPageErrorCapture,
  enrichTimeoutError,
  gotoWithErrorContext,
} from "./page-errors.js";
import {
  installObservers,
  beginObservedWindow,
  readObservedWindow,
  observedInteractionMs,
} from "./observers.js";

// --- Types ---

export interface PathStep {
  interaction: InteractionDescriptor;
}

export interface StateNode {
  id: string;
  depth: number;
  interactions: InteractionDescriptor[];
  pathFromRoot: PathStep[];
}

export interface StateEdge {
  id: string;
  fromId: string;
  toId: string;
  interaction: InteractionDescriptor;
  samples: number[];
  median: number;
  p95: number;
  traces: TraceEvent[][];
  stressPattern?: string;
  // M106 C2 fix-up (C-2): the steps that actually ran, not the pattern's
  // planned count. A truncated `open-close-10` used to report 20 and a
  // per-step cost understated by up to 6.7x.
  stressSteps?: number;
  // Set when the wall-clock budget cut the pattern short; carries the planned
  // count so the row can say how much of the cycle ran.
  stressTruncatedFrom?: number;
}

export interface StateGraph {
  nodes: Map<string, StateNode>;
  edges: StateEdge[];
  initialNodeId: string;
  wallClockMs: number;
  // M47: paths whose content moved on its own, excluded from state hashes.
  volatilePaths?: string[];
}

export interface ExploreOptions {
  samples?: number;
  maxNodes?: number;
  maxWallClockMs?: number;
  maxDepth?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  seed?: number;
  combos?: PropCombination[];
  totalWallClockMs?: number;
  maxCombos?: number;
  // M37: reuse the pooled vsync browser (fresh context per pass). Explore
  // always paces at vsync: its metrics depend on real frame scheduling.
  pool?: import("./measure.js").BrowserPool;
  onWarning?: (warning: string) => void;
  // M52: time interactions with in-page observers instead of a per-sample CDP
  // trace. Opt-in until the A/B acceptance in the milestone spec is met.
  observerTiming?: boolean;
}

// `maxWallClockMs` is spent per combo. Without a run-level bound, a component
// with the full 64-combo matrix can explore for over an hour.
export const DEFAULT_TOTAL_WALL_CLOCK_MS = 300000;
export const DEFAULT_MAX_COMBOS = 8;

// One selection algorithm serves exploration and measurement, so the two never
// disagree about which combos represent the value space.
export function selectExploreCombos(count: number, maxCombos: number): number[] {
  return selectRepresentativeCombos(count, maxCombos);
}

export const EXPLORE_BUDGET_WARNING = (explored: number, total: number): string =>
  `explored ${explored} of ${total} prop combos; ${total - explored} were skipped to stay inside ` +
  `the exploration budget. Skipped combos report no interactions.`;

export interface ExploreResult {
  graph: StateGraph;
  comboIndex: number;
  props: PropCombination;
  // M47: how many DOM regions changed on their own between two idle probes.
  // Non-zero is a finding in itself: the component renders non-deterministically.
  volatileRegions?: number;
}

export const VOLATILE_DOM_NOTICE = (comboIndex: number, regions: number): string =>
  `combo ${comboIndex} has ${regions} DOM ${regions === 1 ? "region" : "regions"} that changed ` +
  "without input (timestamps, random ids, or animation). Their content is excluded from state " +
  "detection so exploration does not chase phantom states; structural change through them still counts.";

// --- Pure utilities ---

// `explore` numbers its results by position in the combos array it was handed.
// A caller that explores a subset must translate those positions back into the
// full combo space, or downstream joins attach interactions to the wrong props.
export function restoreComboIndices<T extends { comboIndex: number }>(
  results: T[],
  sourceIndices: number[],
): T[] {
  return results.map((r) => {
    const restored = sourceIndices[r.comboIndex];
    if (restored === undefined) {
      throw new Error(
        `explore result ${r.comboIndex} has no entry in sourceIndices (length ${sourceIndices.length})`,
      );
    }
    return { ...r, comboIndex: restored };
  });
}

export function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// --- Browser helpers ---

const FUNCTION_MARKER = "__120fps_fn__";

function serializeProps(props: PropCombination): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    result[key] = typeof value === "function" ? FUNCTION_MARKER : value;
  }
  return result;
}

async function mountComponent(
  page: Page,
  props: PropCombination,
): Promise<void> {
  const safeProps = serializeProps(props);
  await page.evaluate(
    ([p, marker]: [any, string]) => {
      (window as any).__120fps.unmount();
      for (const k of Object.keys(p)) {
        if (p[k] === marker) p[k] = () => {};
      }
      (window as any).__120fps.mount(p);
    },
    [safeProps, FUNCTION_MARKER] as [Record<string, unknown>, string],
  );
  await waitForRender(page);
}

async function waitForRender(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

// M47: the gap has to outlast a frame and a short timer without costing more
// than a combo can afford. A once-per-second clock beats it; that miss is
// documented rather than paid for on every combo.
export const VOLATILITY_PROBE_GAP_MS = 250;

// Structure is what the element tree is; content is what it says. A timestamp
// re-rendering is content churn, and attributing state change to it inflates
// the graph toward its node cap chasing phantoms.
//
// Outside a volatile region everything counts. Inside one, attribute values and
// text drop out while tags and attribute names stay: an element appearing or
// disappearing through a volatile region is still a state change.
function serializeTree(volatilePaths: string[]): string {
  const volatile = new Set(volatilePaths);
  const root = document.getElementById("root");
  if (!root) return "";
  let out = "";
  const walk = (el: Element, path: string, inVolatile: boolean): void => {
    const here = inVolatile || volatile.has(path);
    out += "<" + el.tagName;
    for (const name of el.getAttributeNames().sort()) {
      out += " " + name;
      if (!here) out += "=" + el.getAttribute(name);
    }
    out += ">";
    let elementIndex = 0;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        if (!here) out += child.nodeValue;
      } else if (child.nodeType === 1) {
        const childEl = child as Element;
        walk(childEl, path + "/" + childEl.tagName + "[" + elementIndex + "]", here);
        elementIndex++;
      }
    }
    out += "</" + el.tagName + ">";
  };
  walk(root, "", false);
  return out;
}

// Per-element content fingerprints, addressed structurally so a remount between
// the two probes maps to the same regions.
function contentMap(): Record<string, string> {
  const root = document.getElementById("root");
  const map: Record<string, string> = {};
  if (!root) return map;
  const walk = (el: Element, path: string): void => {
    let content = "";
    for (const name of el.getAttributeNames().sort()) {
      content += name + "=" + el.getAttribute(name) + ";";
    }
    let elementIndex = 0;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        content += child.nodeValue;
      } else if (child.nodeType === 1) {
        const childEl = child as Element;
        walk(childEl, path + "/" + childEl.tagName + "[" + elementIndex + "]");
        elementIndex++;
      }
    }
    map[path] = content;
  };
  walk(root, "");
  return map;
}

// Two idle samples with no input in between. Anything whose content moved on
// its own is the DOM's noise floor, not a state.
export async function probeVolatileRegions(
  page: Page,
  gapMs: number = VOLATILITY_PROBE_GAP_MS,
): Promise<string[]> {
  const first = await page.evaluate(contentMap);
  await page.evaluate((ms: number) => new Promise((r) => setTimeout(r, ms)), gapMs);
  const second = await page.evaluate(contentMap);

  const volatile: string[] = [];
  for (const [path, content] of Object.entries(first)) {
    // A path present in only one sample is a structural change, which state
    // detection is supposed to see.
    if (path in second && second[path] !== content) volatile.push(path);
  }
  return volatile.sort();
}

async function computeDomHash(page: Page, volatilePaths: string[] = []): Promise<string> {
  return fnv1aHash(await page.evaluate(serializeTree, volatilePaths));
}

async function exerciseInteraction(
  page: Page,
  desc: InteractionDescriptor,
): Promise<void> {
  const isShadow = desc.selector.includes(">>>");
  try {
    if (isShadow) {
      await exerciseInBrowser(page, desc);
    } else {
      switch (desc.type) {
        case "click":
          await page.click(desc.selector, { timeout: 3000 });
          break;
        case "type":
          await page.fill(desc.selector, "test", { timeout: 3000 });
          break;
        case "select":
          await page.selectOption(desc.selector, { index: 0 }, { timeout: 3000 });
          break;
        case "focus":
          await page.focus(desc.selector);
          break;
        case "keyboard":
          await page.focus(desc.selector);
          await page.keyboard.press("Enter");
          break;
        case "hover":
          await page.hover(desc.selector, { timeout: 3000 });
          break;
        case "scroll":
          // Nothing to reach: scroll edges are state-invariant, so no state
          // node is ever behind one and no replay path contains one.
          break;
      }
    }
  } catch {
    // Element may have disappeared or become non-interactive
  }
  await waitForRender(page);
}

async function exerciseInBrowser(
  page: Page,
  desc: InteractionDescriptor,
): Promise<void> {
  await page.evaluate(
    ({ selector, type }) => {
      const parts = selector.split(" >>> ");
      let el: Element | null = document.querySelector(parts[0]);
      for (let i = 1; i < parts.length && el; i++) {
        el = (el as any).shadowRoot?.querySelector(parts[i]) ?? null;
      }
      if (!el) return;
      const htmlEl = el as HTMLElement;
      switch (type) {
        case "click":
          htmlEl.click();
          break;
        case "type":
          htmlEl.focus();
          if ("value" in htmlEl) {
            (htmlEl as any).value = "test";
            htmlEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
          break;
        case "select":
          if (htmlEl instanceof HTMLSelectElement) {
            htmlEl.selectedIndex = Math.min(1, htmlEl.options.length - 1);
            htmlEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
          break;
        case "focus":
          htmlEl.focus();
          break;
        case "keyboard":
          htmlEl.focus();
          htmlEl.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
          break;
        case "hover":
          htmlEl.dispatchEvent(
            new MouseEvent("mouseenter", { bubbles: true }),
          );
          break;
      }
    },
    { selector: desc.selector, type: desc.type },
  );
}

async function navigateToState(
  page: Page,
  props: PropCombination,
  path: PathStep[],
): Promise<void> {
  await mountComponent(page, props);
  for (const step of path) {
    await exerciseInteraction(page, step.interaction);
  }
}

function computeGlobalMedianEdgeCost(edges: StateEdge[]): number {
  if (edges.length === 0) return 0;
  const medians = edges.map((e) => e.median);
  const sorted = [...medians].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- Work queue ---

interface WorkItem {
  stateId: string;
  interaction: InteractionDescriptor;
  depth: number;
}

// --- Main ---

export async function explore(
  harness: HarnessResult,
  options: ExploreOptions = {},
): Promise<ExploreResult[]> {
  const {
    samples: sampleCount = 10,
    maxNodes = 200,
    maxWallClockMs = 60000,
    maxDepth = 4,
    cpuThrottle = 4,
    warmupRuns = 2,
    seed = 42,
    totalWallClockMs = DEFAULT_TOTAL_WALL_CLOCK_MS,
    maxCombos = DEFAULT_MAX_COMBOS,
  } = options;

  let combos: PropCombination[];
  if (options.combos) {
    combos = options.combos;
  } else {
    const schemas = await extractProps(harness.componentPath);
    combos = generateCombinations(schemas);
    if (combos.length === 0) combos = [{}];
  }

  let browser: Browser | undefined;
  let context: import("playwright").BrowserContext | undefined;
  try {
    if (options.pool) {
      context = await (await options.pool.acquire(false)).newContext();
    } else {
      browser = await chromium.launch({ headless: true });
    }
    const page = context ? await context.newPage() : await browser!.newPage();
    const errorCapture = attachPageErrorCapture(page, path.basename(harness.harnessDir));
    const initialCdp = await page.context().newCDPSession(page);

    // Renamed so a leftover reference to the pre-recovery session cannot
    // compile; see measureMount for the same guard.
    const session: CdpHolder = { cdp: initialCdp };
    const enter = async (): Promise<void> => {
      await refreshCdpSession(page, session);
      await gotoWithErrorContext(page, harness.url, errorCapture, "explorer harness", {
        waitUntil: HARNESS_NAV_WAIT,
      });
      try {
        await page.waitForFunction(
          () => typeof (window as any).__120fps === "object",
          undefined,
          { timeout: 30000 },
        );
      } catch (err) {
        throw enrichTimeoutError(err, errorCapture, "explorer harness");
      }

      await applyWrapperViewport(page);
      reportFontSettle(await settleStyles(page, harness), options.onWarning);
      await session.cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
    };

    // One entry path, used for the first entry and for every recovery: the
    // extra CDP session at startup is cheaper than a second copy of the
    // preamble drifting out of sync with this one.
    // M59: a harness crash mid-exploration escapes here; the phase and the
    // combo in flight are what make it diagnosable.
    const inFlight = createPhaseTracker("explore", harness);
    await inFlight.run(enter);
    const retryBudget = createRetryBudget();

    const results: ExploreResult[] = [];
    const selected = selectExploreCombos(combos.length, maxCombos);
    const runStart = Date.now();

    for (const ci of selected) {
      // The combo already running finishes; only new ones are refused, so a
      // partial state graph is never returned.
      if (results.length > 0 && Date.now() - runStart >= totalWallClockMs) break;
      const props = combos[ci];
      inFlight.combo = ci;
      const graph = await inFlight.run(() => exploreCombo(
        page,
        session,
        props,
        {
          sampleCount,
          maxNodes,
          maxWallClockMs,
          maxDepth,
          warmupRuns,
          seed,
          cpuThrottle,
          observerTiming: options.observerTiming === true,
          comboIndex: ci,
        },
        enter,
        options.onWarning,
        retryBudget,
      ));

      results.push({
        graph,
        comboIndex: ci,
        props,
        ...(graph.volatilePaths ? { volatileRegions: graph.volatilePaths.length } : {}),
      });
    }

    return results;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

interface InternalOptions {
  sampleCount: number;
  maxNodes: number;
  maxWallClockMs: number;
  maxDepth: number;
  warmupRuns: number;
  seed: number;
  cpuThrottle: number;
  observerTiming: boolean;
  // M106 C1: only for the degrade warning's wording — a reader needs to know
  // which combo stopped exploring.
  comboIndex: number;
}

// M106 C1 (calcom-F3): the explore phase had no degrade path at all.
// `withFrameStarvationRetry` already classifies a `tracing-timeout`, and its
// only call sites were in measure.ts, so a second stall inside explore's
// `withContextRetry` body threw raw and ended the run at exit 2 with no
// report — after 124 s on a Radix Popover whose `open-close-10` pattern spent
// 57 s of it in click timeouts. The combo keeps whatever it explored.
// C-7: thrown by the retried body when the explore budget runs out mid-retry.
// `withFrameStarvationRetry` does not classify it as a stall, so it propagates
// out of the retry loop unretried; the call site catches this type and only
// this type, which is what turns "budget gone" into a degrade instead of a
// crash.
class ExploreBudgetSpent extends Error {
  constructor() {
    super("explore wall-clock budget spent");
  }
}

export const EXPLORE_STALLED_WARNING = (comboIndex: number, edgeCount: number): string =>
  `combo ${comboIndex}: explore skipped (tracing stalled); ${edgeCount} interaction` +
  `${edgeCount === 1 ? "" : "s"} measured before the stall are kept and the report still prints`;

async function exploreCombo(
  page: Page,
  session: CdpHolder,
  props: PropCombination,
  opts: InternalOptions,
  enter: () => Promise<void>,
  onWarning?: (warning: string) => void,
  budget?: RetryBudget,
): Promise<StateGraph> {
  const rng = createRng(opts.seed);
  const startTime = Date.now();
  const nodes = new Map<string, StateNode>();
  const edges: StateEdge[] = [];
  const exploredEdges = new Set<string>();
  const convergenceWindow: boolean[] = [];
  const CONVERGENCE_SIZE = 10;

  // Warmup and initial state share the retry: a reload here loses the whole
  // combo, not one sample, so it is the costliest place to be unprotected.
  const { initialHash, initialInteractions, volatile } = await withContextRetry(
    enter,
    async () => {
      for (let w = 0; w < opts.warmupRuns; w++) {
        await mountComponent(page, props);
      }

      await mountComponent(page, props);
      // M47: measure the DOM's own noise floor before attributing any change to
      // an interaction. Runs before discovery so every hash in this combo,
      // including the initial one, speaks the same language.
      const volatile = await probeVolatileRegions(page);
      const hash = await computeDomHash(page, volatile);
      const interactions = await discoverInteractions(page, {
        probePortals: true,
        remount: () => mountComponent(page, props),
      });
      return { initialHash: hash, initialInteractions: interactions, volatile };
    },
    { onRetry: onWarning, budget },
  );

  nodes.set(initialHash, {
    id: initialHash,
    depth: 0,
    interactions: initialInteractions,
    pathFromRoot: [],
  });

  // Work queues: priority (expensive path follow-ups) and normal (BFS)
  const priorityQueue: WorkItem[] = [];
  const normalQueue: WorkItem[] = [];

  const shuffled = shuffleArray(initialInteractions, rng);
  for (const interaction of shuffled) {
    normalQueue.push({ stateId: initialHash, interaction, depth: 0 });
  }

  // M106 C1/C2: one clock for the whole combo. The stress pattern reads what
  // is left of it so a pattern whose every click times out cannot outlive the
  // budget that was supposed to bound it.
  const remainingWallClock = (): number =>
    Math.max(0, opts.maxWallClockMs - (Date.now() - startTime));
  let stalled = false;

  while (priorityQueue.length > 0 || normalQueue.length > 0) {
    if (stalled) break;
    if (Date.now() - startTime >= opts.maxWallClockMs) break;
    if (nodes.size >= opts.maxNodes) break;

    if (convergenceWindow.length >= CONVERGENCE_SIZE) {
      const recent = convergenceWindow.slice(-CONVERGENCE_SIZE);
      if (recent.every((g) => !g)) break;
    }

    const item =
      priorityQueue.length > 0
        ? priorityQueue.shift()!
        : normalQueue.shift()!;

    const sourceNode = nodes.get(item.stateId);
    if (!sourceNode) continue;

    const edgeKey = `${item.stateId}:${item.interaction.selector}:${item.interaction.type}`;
    if (exploredEdges.has(edgeKey)) continue;
    exploredEdges.add(edgeKey);

    // Resolve stress pattern for this interaction
    const siblings = await findAriaGroupSiblings(page, item.interaction);
    const pattern = resolveStressPattern(item.interaction, siblings);

    // Collect N timing samples
    const samples: number[] = [];
    const traces: TraceEvent[][] = [];
    let targetHash: string | null = null;
    // M106 C2 (C-2): what the pattern actually did on the last sample. Both
    // bodies below write it, so a truncated run reaches the edge instead of
    // being discarded at the call site.
    let patternRun: StressPatternRun | undefined;

    for (let s = 0; s < opts.sampleCount; s++) {
      if (Date.now() - startTime >= opts.maxWallClockMs) break;

      // M52: the same exercise, timed two ways. The observer path skips the
      // per-sample trace lifecycle, which is what dominates explore's wall
      // clock; the trace path stays the default until the A/B says otherwise.
      if (opts.observerTiming) {
        // C-12: the same degrade the trace path gets. This path cannot stall on
        // tracing (it starts none), but a `Target closed` still classifies as a
        // stall, and without this it threw raw out of the whole run.
        let observed: Awaited<ReturnType<typeof readObservedWindow>> | undefined;
        if (remainingWallClock() > 0) {
          try {
            observed = await withFrameStarvationRetry(
              opts.comboIndex,
              enter,
              () => {
                if (remainingWallClock() <= 0) throw new ExploreBudgetSpent();
                return withContextRetry(
                  enter,
                  async () => {
                    await suspendThrottle(session.cdp, opts.cpuThrottle, () => tryCollectGarbage(session.cdp));
                    await navigateToState(page, props, sourceNode.pathFromRoot);
                    await installObservers(page);
                    await beginObservedWindow(page);
                    patternRun = await executeStressPattern(page, pattern, remainingWallClock());
                    return readObservedWindow(page);
                  },
                  { onRetry: onWarning, budget: createRetryBudget(0) },
                );
              },
              onWarning,
            );
          } catch (err) {
            if (!(err instanceof ExploreBudgetSpent)) throw err;
          }
        }
        if (observed === undefined) {
          const kept = edges.length + (samples.length > 0 ? 1 : 0);
          onWarning?.(EXPLORE_STALLED_WARNING(opts.comboIndex, kept));
          stalled = true;
          break;
        }
        samples.push(observedInteractionMs(observed));
        traces.push([]);
        if (s === 0) {
          targetHash = pattern.stateInvariant ? item.stateId : await computeDomHash(page, volatile);
        }
        continue;
      }

      // M106 C1 (calcom-F3): the same bounded retry the mount and rerender
      // sample loops already compose around their own bodies. A
      // `tracing-timeout` is one of the stalls it classifies, and explore was
      // the one phase with no call site — so a second stall threw raw out of
      // the whole run instead of degrading this combo.
      // M106 C1 fix-up (C-7): the two retry layers are not disjoint --
      // `CONTEXT_LOST` (src/measure.ts) matches the same `tracing-timeout` and
      // `Target closed` signatures `classifyStall` recovers from, so nesting
      // them multiplied the attempts (5 traced actions per stalled sample,
      // each bounded only by the 60 s trace flush timeout, roughly five
      // minutes past `--explore-budget`). The inner layer gets no budget on
      // this path: the outer one owns the retry, and the wall clock is
      // re-checked before every attempt so the phase cannot outlive the budget
      // it printed.
      let traceEvents: TraceEvent[] | undefined;
      if (remainingWallClock() > 0) {
        try {
          traceEvents = await withFrameStarvationRetry(
            opts.comboIndex,
            enter,
            () => {
              if (remainingWallClock() <= 0) throw new ExploreBudgetSpent();
              return withContextRetry(
                enter,
                async () => {
                  await suspendThrottle(session.cdp, opts.cpuThrottle, () => tryCollectGarbage(session.cdp));
                  await navigateToState(page, props, sourceNode.pathFromRoot);
                  return collectTrace(session.cdp, async () => {
                    patternRun = await executeStressPattern(page, pattern, remainingWallClock());
                  });
                },
                // C-7: zero inner retries. The outer layer owns the retry for
                // the two signatures both layers recognize, so the attempt
                // count is `MAX_FRAME_STARVATION_RETRIES + 1`, not its square.
                { onRetry: onWarning, budget: createRetryBudget(0) },
              );
            },
            onWarning,
          );
        } catch (err) {
          if (!(err instanceof ExploreBudgetSpent)) throw err;
        }
      }
      if (traceEvents === undefined) {
        // C-11: the partially sampled edge below is still pushed whenever any
        // sample survived, so the count has to include it.
        const kept = edges.length + (samples.length > 0 ? 1 : 0);
        onWarning?.(EXPLORE_STALLED_WARNING(opts.comboIndex, kept));
        stalled = true;
        break;
      }

      const parsed = parseTraceDuration(traceEvents);
      samples.push(parsed.totalDuration);
      traces.push(traceEvents);

      if (s === 0) {
        // M43: a state-invariant pattern ends where it started, so the edge is
        // a self-loop. Hashing the DOM here would mint one node per scroll
        // offset as virtualized windowing rewrites the rows.
        targetHash = pattern.stateInvariant ? item.stateId : await computeDomHash(page, volatile);
      }
    }

    if (samples.length === 0 || targetHash === null) continue;

    const edgeId = `${item.stateId}->${targetHash}:${item.interaction.selector}`;
    const edge: StateEdge = {
      id: edgeId,
      fromId: item.stateId,
      toId: targetHash,
      interaction: item.interaction,
      samples,
      median: computeMedian(samples),
      p95: computeP95(samples),
      traces,
      stressPattern: pattern.name,
      stressSteps: patternRun ? patternRun.stepsRun : countPatternEvents(pattern),
      ...(patternRun?.budgetExhausted
        ? { stressTruncatedFrom: patternRun.stepsPlanned }
        : {}),
    };
    edges.push(edge);

    let discoveredNew = false;
    if (!nodes.has(targetHash)) {
      discoveredNew = true;

      // Navigate to target state to discover its interactions
      const targetInteractions = await withContextRetry(
        enter,
        async () => {
          await navigateToState(page, props, sourceNode.pathFromRoot);
          await exerciseInteraction(page, item.interaction);
          return discoverInteractions(page);
        },
        { onRetry: onWarning, budget },
      );

      nodes.set(targetHash, {
        id: targetHash,
        depth: item.depth + 1,
        interactions: targetInteractions,
        pathFromRoot: [
          ...sourceNode.pathFromRoot,
          { interaction: item.interaction },
        ],
      });

      if (item.depth + 1 < opts.maxDepth) {
        const globalMedian = computeGlobalMedianEdgeCost(edges);
        const isExpensive = globalMedian > 0 && edge.p95 > 1.5 * globalMedian;
        const shuffledTarget = shuffleArray(targetInteractions, rng);

        for (const interaction of shuffledTarget) {
          const nextKey = `${targetHash}:${interaction.selector}:${interaction.type}`;
          if (!exploredEdges.has(nextKey)) {
            const wi: WorkItem = {
              stateId: targetHash,
              interaction,
              depth: item.depth + 1,
            };
            if (isExpensive) {
              priorityQueue.push(wi);
            } else {
              normalQueue.push(wi);
            }
          }
        }
      }
    }

    convergenceWindow.push(discoveredNew);
  }

  return {
    nodes,
    edges,
    initialNodeId: initialHash,
    wallClockMs: Date.now() - startTime,
    ...(volatile.length > 0 ? { volatilePaths: volatile } : {}),
  };
}
