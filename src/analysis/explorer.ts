import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { HarnessResult } from "../harness/index.js";
import type { PropCombination } from "../props/index.js";
import { extractProps } from "../props/index.js";
import { generateCombinations, selectRepresentativeCombos } from "../props/index.js";
import { FUNCTION_MARKER, serializeProps } from "../props/index.js";
import { type InteractionDescriptor } from "../browser/index.js";
import { exploreCombo } from "./exploration-loop.js";
import {
  applyWrapperViewport,
  settleStyles,
  reportFontSettle,
  createRetryBudget,
  createPhaseTracker,
  refreshCdpSession,
  type CdpHolder,
  HARNESS_NAV_WAIT,
  type TraceEvent,
} from "../browser/index.js";
import {
  attachPageErrorCapture,
  enrichTimeoutError,
  gotoWithErrorContext,
} from "../browser/index.js";

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
  // Steps that ran, not planned: a truncated open-close-10 reporting 20 understates cost 6.7x.
  stressSteps?: number;
  // The planned count, set when the budget cut the pattern short; the row says how much ran.
  stressTruncatedFrom?: number;
}

export interface StateGraph {
  nodes: Map<string, StateNode>;
  edges: StateEdge[];
  initialNodeId: string;
  wallClockMs: number;
  // Paths whose content moved on its own, excluded from state hashes.
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
  // Explore always paces at vsync: its metrics depend on real frame scheduling.
  pool?: import("../browser/index.js").BrowserPool;
  onWarning?: (warning: string) => void;
  // Opt-in until an A/B comparison against the trace path clears the accuracy bar.
  observerTiming?: boolean;
}

// maxWallClockMs is spent per combo; without a run-level bound a 64-combo matrix runs for an hour.
export const DEFAULT_TOTAL_WALL_CLOCK_MS = 300000;
export const DEFAULT_MAX_COMBOS = 8;

// One selection algorithm for exploration and measurement, so the two never disagree.
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
  // Non-zero is a finding in itself: the component renders non-deterministically.
  volatileRegions?: number;
}

export const VOLATILE_DOM_NOTICE = (comboIndex: number, regions: number): string =>
  `combo ${comboIndex} has ${regions} DOM ${regions === 1 ? "region" : "regions"} that changed ` +
  "without input (timestamps, random ids, or animation). Their content is excluded from state " +
  "detection so exploration does not chase phantom states; structural change through them still counts.";

// A caller that explores a subset must translate positions back, or joins attach the wrong props.
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

export async function mountComponent(
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

// Outlasts a frame and a short timer; a once-per-second clock is missed, not paid for per combo.
export const VOLATILITY_PROBE_GAP_MS = 250;

// Inside a volatile region values and text drop out; tags stay, so structural change still counts.
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

// Addressed structurally, so a remount between the two probes maps to the same regions.
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

// Content that moved with no input in between is the DOM's noise floor, not a state.
export async function probeVolatileRegions(
  page: Page,
  gapMs: number = VOLATILITY_PROBE_GAP_MS,
): Promise<string[]> {
  const first = await page.evaluate(contentMap);
  await page.evaluate((ms: number) => new Promise((r) => setTimeout(r, ms)), gapMs);
  const second = await page.evaluate(contentMap);

  const volatile: string[] = [];
  for (const [path, content] of Object.entries(first)) {
    // A path present in only one sample is a structural change, which state detection must see.
    if (path in second && second[path] !== content) volatile.push(path);
  }
  return volatile.sort();
}

export async function computeDomHash(page: Page, volatilePaths: string[] = []): Promise<string> {
  return fnv1aHash(await page.evaluate(serializeTree, volatilePaths));
}

export async function exerciseInteraction(
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
          // Scroll edges are state-invariant: no state node is behind one, no path contains one.
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

export async function navigateToState(
  page: Page,
  props: PropCombination,
  path: PathStep[],
): Promise<void> {
  await mountComponent(page, props);
  for (const step of path) {
    await exerciseInteraction(page, step.interaction);
  }
}

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

    // A holder, so a stale reference to the pre-recovery session cannot compile; see measureMount.
    const session: CdpHolder = { cdp: initialCdp };
    // One entry path for first entry and every recovery; a second copy would drift out of sync.
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

    // A harness crash escapes here; the phase and the combo in flight make it diagnosable.
    const inFlight = createPhaseTracker("explore", harness);
    await inFlight.run(enter);
    const retryBudget = createRetryBudget();

    const results: ExploreResult[] = [];
    const selected = selectExploreCombos(combos.length, maxCombos);
    const runStart = Date.now();

    for (const ci of selected) {
      // The combo already running finishes; only new ones are refused, so no partial graph.
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
