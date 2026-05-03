import type { Page } from "playwright";
import type { InteractionDescriptor } from "./discovery.js";

export interface StressStep {
  action: "click" | "type" | "fill" | "keyboard" | "hover" | "focus" | "select" | "pointer-drag";
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
}

const KEYBOARD_SWEEP_ROLES = new Set(["tab", "listbox", "combobox", "menu", "tree"]);
const DRAG_CURSORS = new Set(["grab", "col-resize", "row-resize"]);

export function resolveStressPattern(
  descriptor: InteractionDescriptor,
  siblingSelectors?: string[],
): StressPattern {
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
    return buildRapidToggle10(descriptor.selector);
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

function buildRapidToggle10(selector: string): StressPattern {
  const steps: StressStep[] = [];
  for (let i = 0; i < 10; i++) {
    steps.push({ action: "click", selector });
  }
  return { name: "rapid-toggle-10", steps };
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
