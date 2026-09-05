import type { Page } from "playwright";

// A declared but untriggered transition produces no Animation; only running work does.
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

// Counting the whole document adds an ~8 element floor that is not the component's DOM.
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

// `page.evaluate` parses an EXPRESSION, so a bare function declaration is a syntax error.
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

// Same-document fragments only: nothing is requested, so the network capture cannot see these.
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

// Bounded like every collected list in a report: a hundred broken icons say so with ten.
export const MAX_UNRESOLVED_SPRITE_REFS = 10;

export const UNRESOLVED_SPRITE_REFS_EXPRESSION = asEvaluateExpression(
  UNRESOLVED_SPRITE_REFS_SOURCE,
  "__120fpsUnresolvedSpriteRefs(document)",
);

export async function collectUnresolvedSpriteRefs(page: Page): Promise<string[]> {
  const refs = await page.evaluate<string[]>(UNRESOLVED_SPRITE_REFS_EXPRESSION);
  return refs.slice(0, MAX_UNRESOLVED_SPRITE_REFS);
}

// A component that suspends renders a fallback first; a mount over that scene measures wrong.
export type MeasuredState = "settled" | "pending-network" | "late-mutation";

// Long enough for a promise or short-timer re-render to land, short enough to pay per combo.
export const MEASURED_STATE_HOLD_MS = 120;

// Animation mutates the DOM by design, so its mutation proves nothing; network wins.
export function classifyMeasuredState(signals: {
  pendingNetwork: boolean;
  mutated: boolean;
  hasAnimation: boolean;
}): MeasuredState {
  if (signals.pendingNetwork) return "pending-network";
  if (signals.mutated && !signals.hasAnimation) return "late-mutation";
  return "settled";
}

// Wraps the page APIs instead of CDP's Network domain, whose events land in traced windows.
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

// Armed before the DOM and animation probes: their own cost would swallow a late arrival.
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
    // A late portal is a body-level childList change the per-child observers cannot see.
    observer.observe(document.body, { childList: true });
  }, MUTATION_WATCH_KEY);
}

// The hold runs even when mutation does not apply: the network signal reads after it anyway.
export async function endMutationWatch(page: Page, holdMs: number): Promise<boolean> {
  return page.evaluate(
    async ([key, ms]: [string, number]) => {
      // The pump keeps driving frames through this hold, so rAF-scheduled updates land too.
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

// Begin, hold, end: the composed form, for callers with nothing to do in between.
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
