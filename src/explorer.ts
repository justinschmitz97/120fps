import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { HarnessResult } from "./harness.js";
import type { PropCombination } from "./prop-gen-values.js";
import { extractProps } from "./prop-gen.js";
import { generateCombinations } from "./prop-gen-values.js";
import {
  discoverInteractions,
  type InteractionDescriptor,
} from "./discovery.js";
import {
  collectTrace,
  computeMedian,
  computeP95,
  parseTraceDuration,
  tryCollectGarbage,
  type TraceEvent,
} from "./measure.js";

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
}

export interface StateGraph {
  nodes: Map<string, StateNode>;
  edges: StateEdge[];
  initialNodeId: string;
  wallClockMs: number;
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
}

export interface ExploreResult {
  graph: StateGraph;
  comboIndex: number;
  props: PropCombination;
}

// --- Pure utilities ---

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

async function computeDomHash(page: Page): Promise<string> {
  const html = await page.evaluate(() => {
    const root = document.getElementById("root");
    return root ? root.innerHTML : "";
  });
  return fnv1aHash(html);
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
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    await page.goto(harness.url);
    await page.waitForFunction(
      () => typeof (window as any).__120fps === "object",
      { timeout: 10000 },
    );

    const results: ExploreResult[] = [];

    for (let ci = 0; ci < combos.length; ci++) {
      const props = combos[ci];
      const graph = await exploreCombo(
        page,
        cdp,
        props,
        {
          sampleCount,
          maxNodes,
          maxWallClockMs,
          maxDepth,
          warmupRuns,
          seed,
        },
      );

      results.push({ graph, comboIndex: ci, props });
    }

    return results;
  } finally {
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
}

async function exploreCombo(
  page: Page,
  cdp: CDPSession,
  props: PropCombination,
  opts: InternalOptions,
): Promise<StateGraph> {
  const rng = createRng(opts.seed);
  const startTime = Date.now();
  const nodes = new Map<string, StateNode>();
  const edges: StateEdge[] = [];
  const exploredEdges = new Set<string>();
  const convergenceWindow: boolean[] = [];
  const CONVERGENCE_SIZE = 10;

  // Warmup
  for (let w = 0; w < opts.warmupRuns; w++) {
    await mountComponent(page, props);
  }

  // Initial state
  await mountComponent(page, props);
  const initialHash = await computeDomHash(page);
  const initialInteractions = await discoverInteractions(page);

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

  while (priorityQueue.length > 0 || normalQueue.length > 0) {
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

    // Collect N timing samples
    const samples: number[] = [];
    const traces: TraceEvent[][] = [];
    let targetHash: string | null = null;

    for (let s = 0; s < opts.sampleCount; s++) {
      if (Date.now() - startTime >= opts.maxWallClockMs) break;

      await tryCollectGarbage(cdp);
      await navigateToState(page, props, sourceNode.pathFromRoot);

      const traceEvents = await collectTrace(cdp, async () => {
        await exerciseInteraction(page, item.interaction);
      });

      const parsed = parseTraceDuration(traceEvents);
      samples.push(parsed.totalDuration);
      traces.push(traceEvents);

      if (s === 0) {
        targetHash = await computeDomHash(page);
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
    };
    edges.push(edge);

    let discoveredNew = false;
    if (!nodes.has(targetHash)) {
      discoveredNew = true;

      // Navigate to target state to discover its interactions
      await navigateToState(page, props, sourceNode.pathFromRoot);
      await exerciseInteraction(page, item.interaction);
      const targetInteractions = await discoverInteractions(page);

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
  };
}
