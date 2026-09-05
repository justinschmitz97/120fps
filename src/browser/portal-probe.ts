import type { Page } from "playwright";
import { type InteractionDescriptor, type RawElement, toDescriptor } from "./discovery.js";

export async function probePortals(
  page: Page,
  triggers: InteractionDescriptor[],
  remount: () => Promise<void>,
): Promise<InteractionDescriptor[]> {
  const clickOrFocusTriggers = triggers.filter(
    (d) => !d.portal && (d.type === "click" || d.type === "focus"),
  );

  // aria-haspopup narrows the probe set: every probe below costs a remount plus an interaction.
  const portalHintSelectors: string[] = await page.evaluate(
    (selectors: string[]) => {
      const results: string[] = [];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.getAttribute("aria-haspopup")) {
            results.push(sel);
          }
        } catch { /* a discovered selector need not be valid CSS */ }
      }
      return results;
    },
    clickOrFocusTriggers.map((d) => d.selector),
  );

  const hintSet = new Set(portalHintSelectors);
  const triggersToProbe = clickOrFocusTriggers.filter((d) => hintSet.has(d.selector));

  if (triggersToProbe.length === 0) return [];

  const allPortalDescriptors: InteractionDescriptor[] = [];
  const seenPortalSelectors = new Set<string>();

  for (const trigger of triggersToProbe) {
    await remount();

    const beforeCount = await page.evaluate(
      () => document.body.children.length,
    );

    try {
      if (trigger.type === "click") {
        await page.click(trigger.selector, { timeout: 2000 });
      } else {
        await page.focus(trigger.selector);
      }
    } catch {
      continue;
    }

    const appeared = await page.evaluate(
      (before: number) =>
        new Promise<boolean>((resolve) => {
          if (document.body.children.length > before) {
            resolve(true);
            return;
          }
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (document.body.children.length > before) {
                resolve(true);
                return;
              }
              const observer = new MutationObserver(() => {
                if (document.body.children.length > before) {
                  observer.disconnect();
                  resolve(true);
                }
              });
              observer.observe(document.body, { childList: true });
              setTimeout(() => {
                observer.disconnect();
                resolve(document.body.children.length > before);
              }, 2000);
            }),
          );
        }),
      beforeCount,
    );

    if (!appeared) continue;

    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );

    const portalRaw: RawElement[] = await page.evaluate(
      (rootSelectors: string[]) => {
        const known = new Set<Element>();
        const rootEl = document.getElementById("root");
        if (rootEl) {
          const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
          let node: Element | null = walker.currentNode as Element;
          while (node) {
            if (node instanceof Element) known.add(node);
            node = walker.nextNode() as Element | null;
          }
        }
        // Marking them known keeps a trigger that lives outside #root out of the portal results.
        for (const sel of rootSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el) known.add(el);
          } catch { /* ignore invalid selectors */ }
        }

        const results: any[] = [];
        const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT"]);
        const SKIP_IDS = new Set(["root"]);

        function getSelector(el: Element, root: Element): string {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const testId = el.getAttribute("data-testid");
          if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
          const parts: string[] = [];
          let current: Element | null = el;
          while (current && current !== root) {
            const tag = current.tagName.toLowerCase();
            const parent: Element | null = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter(
                (c: Element) => c.tagName === current!.tagName,
              );
              if (siblings.length > 1) {
                const idx = siblings.indexOf(current) + 1;
                parts.unshift(`${tag}:nth-of-type(${idx})`);
              } else {
                parts.unshift(tag);
              }
            } else {
              parts.unshift(tag);
            }
            current = parent;
          }
          return parts.join(" > ");
        }

        function isHidden(el: Element): boolean {
          if (el.getAttribute("aria-hidden") === "true") return true;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return true;
          return false;
        }

        function getAccessibleName(el: Element): string {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel;
          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) return labelEl.textContent?.trim() || "";
          }
          return el.textContent?.trim() || "";
        }

        for (const child of Array.from(document.body.children)) {
          if (!(child instanceof Element)) continue;
          if (SKIP_TAGS.has(child.tagName)) continue;
          if (child.id && SKIP_IDS.has(child.id)) continue;
          if (child.tagName.includes("-") && child.tagName.toLowerCase().startsWith("vite")) continue;

          const walker = document.createTreeWalker(child, NodeFilter.SHOW_ELEMENT);
          let node: Element | null = walker.currentNode as Element;
          while (node) {
            if (node instanceof Element && !known.has(node)) {
              known.add(node);
              if (!SKIP_TAGS.has(node.tagName) && !isHidden(node)) {
                const tag = node.tagName;
                const role = node.getAttribute("role") || "";
                const tabindex = node.getAttribute("tabindex");
                const hasOnclick = node.hasAttribute("onclick");
                const hasOnkeydown = node.hasAttribute("onkeydown");
                const hasOnkeyup = node.hasAttribute("onkeyup");
                const hasOnkeypress = node.hasAttribute("onkeypress");
                const hasOnmousedown = node.hasAttribute("onmousedown");
                const hasOnmouseup = node.hasAttribute("onmouseup");
                const isContentEditable = node.hasAttribute("contenteditable") && node.getAttribute("contenteditable") !== "false";
                const inputType = tag === "INPUT" ? (node as HTMLInputElement).type.toLowerCase() : "";

                const isInteractive =
                  ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(tag) ||
                  role !== "" ||
                  (tabindex !== null && tabindex !== "-1") ||
                  isContentEditable ||
                  hasOnclick || hasOnkeydown || hasOnkeyup || hasOnkeypress ||
                  hasOnmousedown || hasOnmouseup;

                if (!isInteractive) { node = walker.nextNode() as Element | null; continue; }
                if (tag === "A" && !node.hasAttribute("href")) { node = walker.nextNode() as Element | null; continue; }

                const nonInteractiveRoles = new Set(["tablist", "menu", "tree", "region", "tabpanel", "dialog"]);
                if (role && nonInteractiveRoles.has(role) &&
                  !["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(tag) &&
                  tabindex === null && !isContentEditable && !hasOnclick) {
                  node = walker.nextNode() as Element | null;
                  continue;
                }

                const sel = getSelector(node, child);
                results.push({
                  tagName: tag, id: node.id, role,
                  ariaLabel: node.getAttribute("aria-label") || "",
                  ariaControls: node.getAttribute("aria-controls") || "",
                  ariaHaspopup: node.getAttribute("aria-haspopup") || "",
                  ariaExpanded: node.getAttribute("aria-expanded") || "",
                  ariaValueNow: node.getAttribute("aria-valuenow") || "",
                  ariaOrientation: node.getAttribute("aria-orientation") || "",
                  cursor: window.getComputedStyle(node).cursor || "",
                  tabindex, inputType,
                  textContent: getAccessibleName(node),
                  dataTestid: node.getAttribute("data-testid") || "",
                  hasOnclick, hasOnkeydown, hasOnkeyup, hasOnkeypress,
                  hasOnmousedown, hasOnmouseup, isContentEditable,
                  isHidden: false, selector: sel, inShadow: false,
                  portal: true,
                });
              }
            }
            node = walker.nextNode() as Element | null;
          }
        }
        return results;
      },
      triggers.map((t) => t.selector),
    );

    for (const raw of portalRaw) {
      const desc = toDescriptor(raw);
      desc.triggeredBy = trigger.selector;
      if (!seenPortalSelectors.has(desc.selector)) {
        seenPortalSelectors.add(desc.selector);
        allPortalDescriptors.push(desc);
      }
    }
  }

  return allPortalDescriptors;
}
