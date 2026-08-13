import type { Page } from "playwright";
import type { InteractionDescriptor } from "./discovery.js";

export interface StressStep {
  action: "click" | "type" | "fill" | "keyboard" | "hover" | "focus" | "select" | "pointer-drag" | "scroll";
  selector: string;
  key?: string;
  text?: string;
  repeat?: number;
  moveCount?: number;
  direction?: "horizontal" | "vertical";
}

export interface StressPattern {
  name: string;
  steps: StressStep[];
  // M43. The explorer records this edge's cost but does not let the resulting
  // DOM define a state: a virtualized list rewrites its rows on every wheel
  // step, and one node per scroll offset would drown the graph.
  stateInvariant?: boolean;
}

// Ten steps each way. Fixed, because the M33 per-event budget has to be known
// before the sweep runs; the distance per step is what adapts to the container.
export const SCROLL_SWEEP_STEPS = 10;

const KEYBOARD_SWEEP_ROLES = new Set(["tab", "listbox", "combobox", "menu", "tree"]);
const DRAG_CURSORS = new Set(["grab", "col-resize", "row-resize"]);

export function resolveStressPattern(
  descriptor: InteractionDescriptor,
  siblingSelectors?: string[],
): StressPattern {
  // Highest priority: nothing else a scroll container offers is worth more
  // than what its scroll handler costs.
  if (descriptor.type === "scroll") {
    return buildScrollSweep(descriptor.selector, descriptor.scrollAxis ?? "vertical");
  }

  if (isDragTarget(descriptor)) {
    const direction = descriptor.ariaOrientation === "vertical" ? "vertical" : "horizontal";
    return buildPointerDrag(descriptor.selector, direction);
  }

  const hasSiblings = siblingSelectors !== undefined && siblingSelectors.length > 0;

  if (descriptor.role && KEYBOARD_SWEEP_ROLES.has(descriptor.role) && hasSiblings) {
    return buildKeyboardSweep(descriptor.selector, siblingSelectors!);
  }

  if (descriptor.type === "hover" && hasSiblings) {
    return buildHoverSweep(siblingSelectors!);
  }

  if (isPortalTrigger(descriptor)) {
    return buildOpenClose10(descriptor.selector);
  }

  if (descriptor.type === "type") {
    return buildMultiKeystroke(descriptor.selector);
  }

  if (descriptor.type === "click") {
    return buildRapidToggle11(descriptor.selector);
  }

  return buildSingleShot(descriptor);
}

function isDragTarget(descriptor: InteractionDescriptor): boolean {
  if (descriptor.role === "slider") return true;
  if (descriptor.inputType === "range") return true;
  if (descriptor.ariaValueNow) return true;
  if (descriptor.cursor && DRAG_CURSORS.has(descriptor.cursor)) return true;
  return false;
}

function isPortalTrigger(descriptor: InteractionDescriptor): boolean {
  if (descriptor.triggeredBy) return true;
  if (descriptor.role === "dialog") return true;
  return false;
}

function buildKeyboardSweep(selector: string, siblings: string[]): StressPattern {
  const steps: StressStep[] = [{ action: "focus", selector }];
  for (let i = 0; i < siblings.length; i++) {
    steps.push({ action: "keyboard", selector, key: "ArrowDown" });
  }
  steps.push({ action: "keyboard", selector, key: "Home" });
  steps.push({ action: "keyboard", selector, key: "End" });
  return { name: "keyboard-sweep", steps };
}

function buildHoverSweep(siblings: string[]): StressPattern {
  const steps: StressStep[] = siblings.map((sel) => ({
    action: "hover" as const,
    selector: sel,
  }));
  return { name: "hover-sweep", steps };
}

function buildOpenClose10(selector: string): StressPattern {
  const steps: StressStep[] = [];
  for (let i = 0; i < 10; i++) {
    steps.push({ action: "click", selector });
    steps.push({ action: "click", selector });
  }
  return { name: "open-close-10", steps };
}

function buildMultiKeystroke(selector: string): StressPattern {
  const chars = "abcde12345";
  const steps: StressStep[] = [{ action: "focus", selector }];
  for (const ch of chars) {
    steps.push({ action: "type", selector, text: ch });
  }
  return { name: "multi-keystroke", steps };
}

// 11 clicks: odd count so binary toggles end opposite their initial state,
// keeping explorer state discovery (M4) able to see the transition.
function buildRapidToggle11(selector: string): StressPattern {
  const steps: StressStep[] = [];
  for (let i = 0; i < 11; i++) {
    steps.push({ action: "click", selector });
  }
  return { name: "rapid-toggle-11", steps };
}

// Down then back up, ending where it started, so the state graph sees a round
// trip rather than a one-way drift (rapid-toggle-11's end-state discipline).
function buildScrollSweep(selector: string, direction: "horizontal" | "vertical"): StressPattern {
  return {
    name: "scroll-sweep",
    steps: [
      { action: "scroll", selector, moveCount: SCROLL_SWEEP_STEPS * 2, direction },
    ],
    stateInvariant: true,
  };
}

function buildPointerDrag(selector: string, direction: "horizontal" | "vertical"): StressPattern {
  return {
    name: "pointer-drag",
    steps: [{ action: "pointer-drag", selector, moveCount: 60, direction }],
  };
}

function buildSingleShot(descriptor: InteractionDescriptor): StressPattern {
  const step: StressStep = { action: mapTypeToAction(descriptor.type), selector: descriptor.selector };
  if (descriptor.type === "keyboard") step.key = "Enter";
  if (descriptor.type === "type") step.text = "test";
  return { name: "single-shot", steps: [step] };
}

function mapTypeToAction(type: InteractionDescriptor["type"]): StressStep["action"] {
  switch (type) {
    case "click": return "click";
    case "type": return "type";
    case "select": return "select";
    case "focus": return "focus";
    case "keyboard": return "keyboard";
    case "hover": return "hover";
    case "scroll": return "scroll";
  }
}

export async function executeStressPattern(
  page: Page,
  pattern: StressPattern,
): Promise<void> {
  for (const step of pattern.steps) {
    try {
      switch (step.action) {
        case "click":
          await page.click(step.selector, { timeout: 3000 });
          break;
        case "keyboard":
          await page.keyboard.press(step.key!);
          break;
        case "hover":
          await page.hover(step.selector, { timeout: 3000 });
          break;
        case "type":
          await page.keyboard.type(step.text!, { delay: 0 });
          break;
        case "focus":
          await page.focus(step.selector);
          break;
        case "fill":
          await page.fill(step.selector, step.text!, { timeout: 3000 });
          break;
        case "select":
          await page.selectOption(step.selector, { index: 0 }, { timeout: 3000 });
          break;
        case "scroll": {
          const target = await scrollTarget(page, step.selector, step.direction === "horizontal");
          if (!target) break;
          const half = Math.max(1, Math.floor((step.moveCount ?? SCROLL_SWEEP_STEPS * 2) / 2));
          const horizontal = step.direction === "horizontal";
          // The wheel goes wherever the pointer is, so it has to sit over the
          // container before the first tick.
          await page.mouse.move(target.x, target.y);
          for (let i = 0; i < half; i++) {
            await page.mouse.wheel(horizontal ? target.delta : 0, horizontal ? 0 : target.delta);
          }
          for (let i = 0; i < half; i++) {
            await page.mouse.wheel(horizontal ? -target.delta : 0, horizontal ? 0 : -target.delta);
          }
          break;
        }
        case "pointer-drag": {
          const rect = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }, step.selector);
          if (!rect) break;
          const count = step.moveCount ?? 60;
          const vertical = step.direction === "vertical";
          const startX = vertical ? rect.x + rect.width / 2 : rect.x;
          const startY = vertical ? rect.y : rect.y + rect.height / 2;
          const endX = vertical ? rect.x + rect.width / 2 : rect.x + rect.width;
          const endY = vertical ? rect.y + rect.height : rect.y + rect.height / 2;
          await page.mouse.move(startX, startY);
          await page.mouse.down();
          for (let i = 0; i <= count; i++) {
            const t = i / count;
            await page.mouse.move(
              startX + (endX - startX) * t,
              startY + (endY - startY) * t,
            );
          }
          await page.mouse.up();
          break;
        }
      }
    } catch {
      // Element may have disappeared or become non-interactive
    }
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  }
}

// Where to put the pointer and how far one wheel tick travels. The step size
// adapts so a 10-row list traverses exactly its range while a virtualized list
// reporting a 400,000px scrollHeight still stops after eight viewports —
// representative either way, bounded always.
async function scrollTarget(
  page: Page,
  selector: string,
  horizontal: boolean,
): Promise<{ x: number; y: number; delta: number } | null> {
  return page.evaluate(
    ([sel, isHorizontal, steps]: [string, boolean, number]) => {
      const viewportW = document.documentElement.clientWidth;
      const viewportH = document.documentElement.clientHeight;
      const isRoot = sel === ":root";
      const el = isRoot
        ? (document.scrollingElement as HTMLElement | null)
        : (document.querySelector(sel) as HTMLElement | null);
      if (!el) return null;

      // Smooth scrolling would measure easing duration instead of handler
      // cost. Forcing `auto` is idempotent, so repeated sweeps see one state.
      el.style.scrollBehavior = "auto";

      const range = isHorizontal
        ? el.scrollWidth - el.clientWidth
        : el.scrollHeight - el.clientHeight;
      if (range <= 0) return null;

      const box = isHorizontal ? el.clientWidth : el.clientHeight;
      const delta = Math.max(1, Math.round(Math.min(box * 0.8, range / steps)));

      if (isRoot) {
        return { x: Math.floor(viewportW / 2), y: Math.floor(viewportH / 2), delta };
      }
      const rect = el.getBoundingClientRect();
      // Clamped into the viewport: a wheel event at negative coordinates
      // lands on nothing.
      const x = Math.min(Math.max(rect.x + rect.width / 2, 1), viewportW - 1);
      const y = Math.min(Math.max(rect.y + rect.height / 2, 1), viewportH - 1);
      return { x, y, delta };
    },
    [selector, horizontal, SCROLL_SWEEP_STEPS] as [string, boolean, number],
  );
}

const ARIA_CONTAINER_MAP: Record<string, { container: string; item: string }> = {
  tab: { container: "[role=tablist]", item: "[role=tab]" },
  listbox: { container: "[role=listbox]", item: "[role=option]" },
  menu: { container: "[role=menu]", item: "[role=menuitem]" },
  tree: { container: "[role=tree]", item: "[role=treeitem]" },
  combobox: { container: "[role=listbox]", item: "[role=option]" },
};

export async function findAriaGroupSiblings(
  page: Page,
  descriptor: InteractionDescriptor,
): Promise<string[]> {
  if (descriptor.type === "hover") {
    return page.evaluate(
      (selector: string) => {
        const el = document.querySelector(selector);
        if (!el || !el.parentElement) return [];
        const parent = el.parentElement;
        const tag = el.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === el.tagName,
        );
        return siblings.map((s, i) => {
          if (s.id) return `#${CSS.escape(s.id)}`;
          const testId = s.getAttribute("data-testid");
          if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
          return `${tag}:nth-of-type(${i + 1})`;
        });
      },
      descriptor.selector,
    );
  }

  const role = descriptor.role;
  if (!role) return [];

  const mapping = ARIA_CONTAINER_MAP[role];
  if (!mapping) return [];

  return page.evaluate(
    ({ selector, containerSel, itemSel }: { selector: string; containerSel: string; itemSel: string }) => {
      const el = document.querySelector(selector);
      if (!el) return [];
      const container = el.closest(containerSel);
      if (!container) return [];
      const items = Array.from(container.querySelectorAll(itemSel));
      return items.map((item) => {
        if (item.id) return `#${CSS.escape(item.id)}`;
        const testId = item.getAttribute("data-testid");
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const tag = item.tagName.toLowerCase();
        const siblings = Array.from(container.querySelectorAll(itemSel));
        const idx = siblings.indexOf(item) + 1;
        return `${containerSel} > ${tag}:nth-of-type(${idx})`;
      });
    },
    { selector: descriptor.selector, containerSel: mapping.container, itemSel: mapping.item },
  );
}

// A step is not an event: every pattern enumerates one step per event except
// pointer-drag, which carries 60 moves in a single step. Budgets are per
// event, so a drag must not be compared as though it were one interaction.
export function countPatternEvents(pattern: StressPattern): number {
  const total = pattern.steps.reduce((sum, step) => sum + (step.moveCount ?? 1), 0);
  return total > 0 ? total : 1;
}
