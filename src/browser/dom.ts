import type { Page } from "playwright";

// Animation is what the page is *doing*, never what its stylesheet
// declares. A Tailwind `transition-all` on an idle button declares a transition
// and animates nothing; reading it as animation would force static toolbars
// into T3. Every real case: a CSS animation, a running transition, a WAAPI
// animation: produces an `Animation` object here; a declared-but-untriggered
// transition produces none.
//
// Exported as source rather than a closure so the rule is one definition and
// can be exercised against stub objects without a browser.
export const OBSERVED_ANIMATION_EXPRESSION = `(function () {
  var root = document.getElementById("root");
  if (!root) return false;
  var animations = document.getAnimations();
  for (var i = 0; i < animations.length; i++) {
    var animation = animations[i];
    var effect = animation.effect;
    var target = effect ? effect.target : null;
    // Pseudo-element targets are not nodes and cannot be located in the tree.
    if (!target || typeof target.nodeType !== "number") continue;
    if (!root.contains(target)) continue;
    // "idle" is a cancelled or never-started animation; "finished" still ran
    // during the mount that was measured.
    if (animation.playState === "idle") continue;
    return true;
  }
  return false;
})()`;

export async function detectAnimations(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(OBSERVED_ANIMATION_EXPRESSION);
}

// `document.querySelectorAll("*")` counts html/head/body/#root and Vite's
// injected scripts, an ~8 element floor that is not the component's DOM and
// that pushed small components a whole tier up. Count what the component
// actually rendered: everything inside #root, plus portal content, which lives
// on document.body but belongs to the component.
//
// The two halves are reported separately. The sum is what
// every existing caller reads and is unchanged; the split is what lets a
// report say "this component rendered only through a portal" instead of
// leaving `domNodeCount` to carry both facts at once. Kept as a source string
// so the same code a page runs is the code a unit test runs (the harness
// entry's `stylesheetMatchStats` precedent).
export const COMPONENT_NODE_COUNT_SOURCE = `
function __120fpsCountComponentNodes(doc) {
  var INTERNAL = { SCRIPT: 1, STYLE: 1, LINK: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var root = doc.getElementById("root");
  var rootNodes = root ? root.querySelectorAll("*").length : 0;
  var orphanNodes = 0;
  var children = Array.prototype.slice.call(doc.body.children);
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (root && child === root) continue;
    if (INTERNAL[child.tagName]) continue;
    if (child.localName && child.localName.indexOf("vite-") === 0) continue;
    orphanNodes += 1 + child.querySelectorAll("*").length;
  }
  return { rootNodes: rootNodes, orphanNodes: orphanNodes };
}`;

export interface ComponentNodeCount {
  // Everything the component rendered inside `#root`.
  rootNodes: number;
  // Everything it rendered outside `#root`, at body level: portals.
  orphanNodes: number;
}

// `page.evaluate` parses a string as an EXPRESSION, so a bare function
// declaration followed by a call is a syntax error at `eval`. Every source
// string above is handed over wrapped in an IIFE, and the wrapped form is
// exported so a unit test can assert it parses.
function asEvaluateExpression(source: string, call: string): string {
  return `(() => { ${source}
return ${call}; })()`;
}

export const COMPONENT_NODE_COUNT_EXPRESSION = asEvaluateExpression(
  COMPONENT_NODE_COUNT_SOURCE,
  "__120fpsCountComponentNodes(document)",
);

export async function countComponentNodes(page: Page): Promise<ComponentNodeCount> {
  return page.evaluate<ComponentNodeCount>(COMPONENT_NODE_COUNT_EXPRESSION);
}

export function totalComponentNodes(count: ComponentNodeCount): number {
  return count.rootNodes + count.orphanNodes;
}

// `<use href="#calendar">` is a same-document fragment
// reference. Nothing is requested, so the network capture is blind to it, and
// the `<svg>` plus the `<use>` count as two real nodes -- a component that
// renders visibly nothing measures as a component that rendered. calcom's
// sprite is injected by `apps/web/app/layout.tsx`, which the harness never
// mounts.
//
// Same-document fragments only. An external `<use href="/icons.svg#id">` is
// fetched by the browser and its target never enters `document`, so
// `getElementById` cannot decide it and checking it would report every valid
// external sprite as unresolved.
export const UNRESOLVED_SPRITE_REFS_SOURCE = `
function __120fpsUnresolvedSpriteRefs(doc) {
  var INTERNAL = { SCRIPT: 1, STYLE: 1, LINK: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var scopes = [];
  var root = doc.getElementById("root");
  if (root) scopes.push(root);
  var children = Array.prototype.slice.call(doc.body.children);
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (root && child === root) continue;
    if (INTERNAL[child.tagName]) continue;
    if (child.localName && child.localName.indexOf("vite-") === 0) continue;
    scopes.push(child);
  }
  var missing = [];
  var seen = {};
  for (var s = 0; s < scopes.length; s++) {
    var nodes = Array.prototype.slice.call(scopes[s].querySelectorAll("*"));
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      if (!node.localName || node.localName.toLowerCase() !== "use") continue;
      var ref = node.getAttribute("href");
      if (!ref) ref = node.getAttribute("xlink:href");
      if (!ref || ref.charAt(0) !== "#") continue;
      if (seen[ref]) continue;
      seen[ref] = 1;
      if (!doc.getElementById(ref.slice(1))) missing.push(ref);
    }
  }
  return missing;
}`;

// Bounded like every other collected list in a report: a component with a
// hundred broken icons says so with ten of them.
export const MAX_UNRESOLVED_SPRITE_REFS = 10;

export const UNRESOLVED_SPRITE_REFS_EXPRESSION = asEvaluateExpression(
  UNRESOLVED_SPRITE_REFS_SOURCE,
  "__120fpsUnresolvedSpriteRefs(document)",
);

export async function collectUnresolvedSpriteRefs(page: Page): Promise<string[]> {
  const refs = await page.evaluate<string[]>(UNRESOLVED_SPRITE_REFS_EXPRESSION);
  return refs.slice(0, MAX_UNRESOLVED_SPRITE_REFS);
}

// What scene the numbers describe. A component that fetches, suspends, or
// defers work renders a fallback first, and a mount measurement over that scene
// is a real number about the wrong thing.
export type MeasuredState = "settled" | "pending-network" | "late-mutation";

// Grace window held after the mount fence, in real time: long enough for a
// promise-resolution or short-timer re-render to land, short enough that every
// combo can pay it once. Timers run on wall clock under the frame pump, and
// the pump keeps driving frames throughout, so rAF-scheduled updates land too.
export const MEASURED_STATE_HOLD_MS = 120;

// Animation mutates the DOM by design, so an animated combo's mutation says
// nothing about settledness. The network signal is unaffected by it, and it
// names a cause the mutation signal only hints at, so it wins when both fire.
export function classifyMeasuredState(signals: {
  pendingNetwork: boolean;
  mutated: boolean;
  hasAnimation: boolean;
}): MeasuredState {
  if (signals.pendingNetwork) return "pending-network";
  if (signals.mutated && !signals.hasAnimation) return "late-mutation";
  return "settled";
}

// Counts in-flight fetch/XHR by wrapping the page's own APIs rather than
// enabling CDP's Network domain: the domain's event traffic lands inside traced
// windows, and enabling it for the probing sample only would make that sample's
// conditions differ from the rest of the median. The wrapper is installed once
// per page, before anything mounts, so every sample runs under identical
// instrumentation and the counters are read outside traced windows.
//
// Each request carries a monotonic id, so "pending" can be narrowed to requests
// that started during the mount rather than leftovers from an earlier combo.
const MEASURED_STATE_PROBE = `(() => {
  const w = window;
  if (w.__120fpsNet) return;
  const state = { started: 0, pending: new Set() };
  w.__120fpsNet = state;
  const track = (settled) => {
    const id = ++state.started;
    state.pending.add(id);
    settled.then(() => state.pending.delete(id), () => state.pending.delete(id));
  };
  const origFetch = w.fetch;
  if (typeof origFetch === "function") {
    w.fetch = function (...args) {
      // A synchronous throw never started a request, so it is never tracked.
      const p = origFetch.apply(this, args);
      track(p);
      return p;
    };
  }
  const XHR = w.XMLHttpRequest;
  if (typeof XHR === "function" && XHR.prototype && XHR.prototype.send) {
    const send = XHR.prototype.send;
    XHR.prototype.send = function (...args) {
      // The listener goes on before send: a synchronous XHR fires loadend
      // inside send(), and attaching afterwards would miss it forever.
      let settle;
      const done = new Promise((resolve) => { settle = resolve; });
      this.addEventListener("loadend", () => settle(), { once: true });
      track(done);
      try {
        return send.apply(this, args);
      } catch (err) {
        // send never started, so no loadend is coming.
        settle();
        throw err;
      }
    };
  }
})()`;

export async function installMeasuredStateProbe(page: Page): Promise<void> {
  await page.evaluate(MEASURED_STATE_PROBE);
}

export async function readNetworkProbe(
  page: Page,
): Promise<{ started: number; pending: number[] }> {
  return page.evaluate(() => {
    const state = (window as any).__120fpsNet;
    if (!state) return { started: 0, pending: [] as number[] };
    return { started: state.started as number, pending: [...state.pending] as number[] };
  });
}

const MUTATION_WATCH_KEY = "__120fpsMut";

// Armed the moment the mount fence clears, before the DOM-count and animation
// probes run. Those probes cost real time under a CPU throttle, and a component
// whose content arrives while they are running would otherwise be classified
// settled because our own instrumentation ate the window.
export async function beginMutationWatch(page: Page): Promise<void> {
  await page.evaluate((key: string) => {
    const w = window as any;
    if (w[key]?.observer) w[key].observer.disconnect();

    const INTERNAL = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT", "TEMPLATE"]);
    const root = document.getElementById("root");
    const state = { mutated: false, observer: null as MutationObserver | null };
    w[key] = state;

    const observer = new MutationObserver(() => {
      state.mutated = true;
    });
    state.observer = observer;
    const options = {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    };
    if (root) observer.observe(root, options);
    for (const child of Array.from(document.body.children)) {
      if (child === root) continue;
      if (INTERNAL.has(child.tagName)) continue;
      if (child.localName.startsWith("vite-")) continue;
      observer.observe(child, options);
    }
    // A portal that appears late is a body-level childList change, which the
    // per-child observers above cannot see.
    observer.observe(document.body, { childList: true });
  }, MUTATION_WATCH_KEY);
}

// Holds the remainder of the grace window, then reports what moved. The hold
// runs whether or not the mutation signal applies to this combo: the network
// signal reads after the same window either way.
export async function endMutationWatch(page: Page, holdMs: number): Promise<boolean> {
  return page.evaluate(
    async ([key, ms]: [string, number]) => {
      await new Promise((r) => setTimeout(r, ms));
      const state = (window as any)[key];
      if (!state) return false;
      state.observer?.disconnect();
      state.observer = null;
      return state.mutated === true;
    },
    [MUTATION_WATCH_KEY, holdMs] as [string, number],
  );
}

// Begin, hold, end: the composed form, for callers that have nothing to do in
// between.
export async function probeLateMutation(
  page: Page,
  holdMs: number,
  observe: boolean,
): Promise<boolean> {
  if (!observe) {
    await page.evaluate((ms: number) => new Promise((r) => setTimeout(r, ms)), holdMs);
    return false;
  }
  await beginMutationWatch(page);
  return endMutationWatch(page, holdMs);
}
