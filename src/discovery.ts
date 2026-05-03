import type { Page } from "playwright";

export type InteractionType =
  | "click"
  | "type"
  | "select"
  | "focus"
  | "keyboard"
  | "hover";

export interface InteractionDescriptor {
  type: InteractionType;
  selector: string;
  tagName: string;
  label: string;
  role?: string;
  inputType?: string;
  portal?: boolean;
  triggeredBy?: string;
  ariaValueNow?: boolean;
  ariaOrientation?: string;
  cursor?: string;
}

export interface DiscoverOptions {
  probePortals?: boolean;
  remount?: () => Promise<void>;
}

interface RawElement {
  tagName: string;
  id: string;
  role: string;
  ariaLabel: string;
  ariaControls: string;
  ariaHaspopup: string;
  ariaExpanded: string;
  ariaValueNow: string;
  ariaOrientation: string;
  cursor: string;
  tabindex: string | null;
  inputType: string;
  textContent: string;
  dataTestid: string;
  hasOnclick: boolean;
  hasOnkeydown: boolean;
  hasOnkeyup: boolean;
  hasOnkeypress: boolean;
  hasOnmousedown: boolean;
  hasOnmouseup: boolean;
  isContentEditable: boolean;
  isHidden: boolean;
  selector: string;
  inShadow: boolean;
  portal?: boolean;
}

const TYPEABLE_INPUT_TYPES = new Set([
  "text",
  "email",
  "password",
  "search",
  "url",
  "tel",
  "number",
]);

const CLICKABLE_INPUT_TYPES = new Set(["checkbox", "radio", "range"]);

const CLICK_ROLES = new Set([
  "button",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "option",
]);

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK"]);

export async function discoverInteractions(
  page: Page,
  options?: DiscoverOptions,
): Promise<InteractionDescriptor[]> {
  const rawElements: RawElement[] = await page.evaluate(() => {
    const results: any[] = [];
    const seen = new Set<Element>();

    function getSelector(el: Element, root: Element | ShadowRoot): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const testId = el.getAttribute("data-testid");
      if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
      return buildPositionalSelector(el, root);
    }

    function buildPositionalSelector(
      el: Element,
      root: Element | ShadowRoot,
    ): string {
      const parts: string[] = [];
      let current: Element | null = el;
      const rootEl = root instanceof ShadowRoot ? root.host : root;

      while (current && current !== rootEl) {
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
      if (style.display === "none" || style.visibility === "hidden")
        return true;
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

    function walkTree(
      root: Element | ShadowRoot,
      selectorPrefix: string,
      portalFlag?: boolean,
    ) {
      const container =
        root instanceof ShadowRoot ? root : root;
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_ELEMENT,
      );
      let node: Element | null = walker.currentNode as Element;

      while (node) {
        if (node instanceof Element && !seen.has(node)) {
          seen.add(node);
          const tag = node.tagName;

          if (
            !["SCRIPT", "STYLE", "LINK"].includes(tag) &&
            node.id !== "root"
          ) {
            if (!isHidden(node)) {
              const raw = extractRaw(node, root, selectorPrefix, portalFlag);
              if (raw) results.push(raw);
            }
          }

          if ((node as any).shadowRoot) {
            const shadow = (node as any).shadowRoot as ShadowRoot;
            const hostSelector =
              selectorPrefix + getSelector(node, root);
            walkShadow(shadow, hostSelector, portalFlag);
          }
        }
        node = walker.nextNode() as Element | null;
      }
    }

    function walkShadow(shadow: ShadowRoot, hostSelector: string, portalFlag?: boolean) {
      const walker = document.createTreeWalker(
        shadow,
        NodeFilter.SHOW_ELEMENT,
      );
      let node: Element | null = walker.currentNode as Element;
      while (node) {
        if (node instanceof Element && !seen.has(node)) {
          seen.add(node);
          const tag = node.tagName;
          if (
            !["SCRIPT", "STYLE", "LINK"].includes(tag)
          ) {
            if (!isHidden(node)) {
              const raw = extractRawShadow(node, shadow, hostSelector, portalFlag);
              if (raw) results.push(raw);
            }
          }
          if ((node as any).shadowRoot) {
            const innerShadow = (node as any).shadowRoot as ShadowRoot;
            const sel = hostSelector + " >>> " + getShadowSelector(node, shadow);
            walkShadow(innerShadow, sel, portalFlag);
          }
        }
        node = walker.nextNode() as Element | null;
      }
    }

    function getShadowSelector(el: Element, shadow: ShadowRoot): string {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `#${CSS.escape(el.id)}`;
      const siblings = Array.from(shadow.querySelectorAll(tag));
      if (siblings.length > 1) {
        const idx = siblings.indexOf(el) + 1;
        return `${tag}:nth-of-type(${idx})`;
      }
      return tag;
    }

    function extractRawShadow(
      el: Element,
      shadow: ShadowRoot,
      hostSelector: string,
      portalFlag?: boolean,
    ): any | null {
      const tag = el.tagName;
      const role = el.getAttribute("role") || "";
      const tabindex = el.getAttribute("tabindex");
      const hasOnclick = el.hasAttribute("onclick");
      const hasOnkeydown = el.hasAttribute("onkeydown");
      const hasOnkeyup = el.hasAttribute("onkeyup");
      const hasOnkeypress = el.hasAttribute("onkeypress");
      const hasOnmousedown = el.hasAttribute("onmousedown");
      const hasOnmouseup = el.hasAttribute("onmouseup");
      const isContentEditable = (el as HTMLElement).isContentEditable && !el.closest("[contenteditable]")?.contains(el.parentElement?.closest("[contenteditable]") ?? el);
      const inputType =
        tag === "INPUT"
          ? (el as HTMLInputElement).type.toLowerCase()
          : "";

      const isInteractive =
        ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(
          tag,
        ) ||
        role !== "" ||
        (tabindex !== null && tabindex !== "-1") ||
        isContentEditable ||
        hasOnclick ||
        hasOnkeydown ||
        hasOnkeyup ||
        hasOnkeypress ||
        hasOnmousedown ||
        hasOnmouseup;

      if (!isInteractive) return null;

      if (tag === "A" && !el.hasAttribute("href")) return null;

      const shadowSel = getShadowSelector(el, shadow);

      return {
        tagName: tag,
        id: el.id,
        role,
        ariaLabel: el.getAttribute("aria-label") || "",
        ariaControls: el.getAttribute("aria-controls") || "",
        ariaHaspopup: el.getAttribute("aria-haspopup") || "",
        ariaExpanded: el.getAttribute("aria-expanded") || "",
        ariaValueNow: el.getAttribute("aria-valuenow") || "",
        ariaOrientation: el.getAttribute("aria-orientation") || "",
        cursor: window.getComputedStyle(el).cursor || "",
        tabindex,
        inputType,
        textContent: getAccessibleName(el),
        dataTestid: el.getAttribute("data-testid") || "",
        hasOnclick,
        hasOnkeydown,
        hasOnkeyup,
        hasOnkeypress,
        hasOnmousedown,
        hasOnmouseup,
        isContentEditable,
        isHidden: false,
        selector: hostSelector + " >>> " + shadowSel,
        inShadow: true,
        ...(portalFlag ? { portal: true } : {}),
      };
    }

    function extractRaw(
      el: Element,
      root: Element | ShadowRoot,
      selectorPrefix: string,
      portalFlag?: boolean,
    ): any | null {
      const tag = el.tagName;
      const role = el.getAttribute("role") || "";
      const tabindex = el.getAttribute("tabindex");
      const hasOnclick = el.hasAttribute("onclick");
      const hasOnkeydown = el.hasAttribute("onkeydown");
      const hasOnkeyup = el.hasAttribute("onkeyup");
      const hasOnkeypress = el.hasAttribute("onkeypress");
      const hasOnmousedown = el.hasAttribute("onmousedown");
      const hasOnmouseup = el.hasAttribute("onmouseup");
      const isContentEditable = el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false";
      const inputType =
        tag === "INPUT"
          ? (el as HTMLInputElement).type.toLowerCase()
          : "";

      const interactiveRoles = new Set([
        "button", "link", "tab", "menuitem", "menuitemcheckbox",
        "menuitemradio", "checkbox", "radio", "switch", "option",
        "slider", "spinbutton", "scrollbar", "combobox", "searchbox",
        "textbox", "treeitem", "gridcell", "listbox",
      ]);
      const hasInteractiveRole = role !== "" && interactiveRoles.has(role);

      const isInteractive =
        ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(
          tag,
        ) ||
        hasInteractiveRole ||
        (tabindex !== null && tabindex !== "-1") ||
        isContentEditable ||
        hasOnclick ||
        hasOnkeydown ||
        hasOnkeyup ||
        hasOnkeypress ||
        hasOnmousedown ||
        hasOnmouseup;

      if (!isInteractive) return null;

      if (tag === "A" && !el.hasAttribute("href")) return null;

      const sel = selectorPrefix + getSelector(el, root);

      return {
        tagName: tag,
        id: el.id,
        role,
        ariaLabel: el.getAttribute("aria-label") || "",
        ariaControls: el.getAttribute("aria-controls") || "",
        ariaHaspopup: el.getAttribute("aria-haspopup") || "",
        ariaExpanded: el.getAttribute("aria-expanded") || "",
        ariaValueNow: el.getAttribute("aria-valuenow") || "",
        ariaOrientation: el.getAttribute("aria-orientation") || "",
        cursor: window.getComputedStyle(el).cursor || "",
        tabindex,
        inputType,
        textContent: getAccessibleName(el),
        dataTestid: el.getAttribute("data-testid") || "",
        hasOnclick,
        hasOnkeydown,
        hasOnkeyup,
        hasOnkeypress,
        hasOnmousedown,
        hasOnmouseup,
        isContentEditable,
        isHidden: false,
        selector: sel,
        inShadow: false,
        ...(portalFlag ? { portal: true } : {}),
      };
    }

    const SKIP_BODY_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT"]);
    const SKIP_BODY_IDS = new Set(["root"]);

    const rootEl = document.getElementById("root");
    if (rootEl) {
      walkTree(rootEl, "");
    }

    // Walk body children outside #root for portal content
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof Element)) continue;
      if (SKIP_BODY_TAGS.has(child.tagName)) continue;
      if (child.id && SKIP_BODY_IDS.has(child.id)) continue;
      if (child.tagName.includes("-") && child.tagName.toLowerCase().startsWith("vite")) continue;
      if (seen.has(child)) continue;
      walkTree(child, "", true);
    }

    return results;
  });

  const rootDescriptors = rawElements.map((raw) => toDescriptor(raw));

  if (!options?.probePortals || !options.remount) {
    return rootDescriptors;
  }

  // Phase 2: trigger-first portal probing
  const portalDescriptors = await probePortals(page, rootDescriptors, options.remount);
  return [...rootDescriptors, ...portalDescriptors];
}

async function probePortals(
  page: Page,
  triggers: InteractionDescriptor[],
  remount: () => Promise<void>,
): Promise<InteractionDescriptor[]> {
  const clickOrFocusTriggers = triggers.filter(
    (d) => !d.portal && (d.type === "click" || d.type === "focus"),
  );

  // Batch-check which triggers have ARIA portal hints (aria-haspopup indicates popup content)
  const portalHintSelectors: string[] = await page.evaluate(
    (selectors: string[]) => {
      const results: string[] = [];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.getAttribute("aria-haspopup")) {
            results.push(sel);
          }
        } catch { /* ignore */ }
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

    // Walk new portal content
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
        // Also mark elements already discovered by selector
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

function toDescriptor(raw: RawElement): InteractionDescriptor {
  const desc: InteractionDescriptor = {
    type: inferType(raw),
    selector: fixSelector(raw.selector),
    tagName: raw.tagName,
    label: raw.textContent.slice(0, 200),
    ...(raw.inputType ? { inputType: raw.inputType } : {}),
  };

  const ariaRole = inferAriaRole(raw);
  if (ariaRole) desc.role = ariaRole;
  if (raw.portal) desc.portal = true;
  if (raw.ariaValueNow) desc.ariaValueNow = true;
  if (raw.ariaOrientation) desc.ariaOrientation = raw.ariaOrientation;
  if (raw.cursor) desc.cursor = raw.cursor;

  return desc;
}

function inferType(raw: RawElement): InteractionType {
  const tag = raw.tagName;
  const role = raw.role;

  if (raw.isContentEditable) return "type";

  if (tag === "INPUT") {
    if (TYPEABLE_INPUT_TYPES.has(raw.inputType)) return "type";
    if (CLICKABLE_INPUT_TYPES.has(raw.inputType)) return "click";
    return "click";
  }
  if (tag === "TEXTAREA") return "type";
  if (tag === "SELECT") return "select";
  if (tag === "BUTTON" || tag === "SUMMARY") return "click";
  if (tag === "A") return "click";

  if (role === "combobox") return "type";
  if (role === "listbox") return "select";
  if (CLICK_ROLES.has(role)) return "click";

  if (
    raw.hasOnkeydown ||
    raw.hasOnkeyup ||
    raw.hasOnkeypress
  ) {
    if (
      !raw.hasOnclick &&
      !raw.hasOnmousedown &&
      !raw.hasOnmouseup
    )
      return "keyboard";
  }

  if (raw.hasOnclick || raw.hasOnmousedown || raw.hasOnmouseup)
    return "click";

  if (raw.tabindex !== null && raw.tabindex !== "-1") return "focus";

  return "click";
}

function inferAriaRole(raw: RawElement): string | undefined {
  const role = raw.role;

  if (role === "slider") return "slider";
  if (role === "tab") return "tab";
  if (role === "menuitem" || role === "menuitemcheckbox" || role === "menuitemradio")
    return "menu";
  if (role === "option") return "listbox";
  if (role === "treeitem") return "tree";
  if (role === "combobox") return "combobox";
  if (role === "listbox") return "listbox";

  if (raw.ariaHaspopup === "dialog") return "dialog";

  if (raw.ariaControls) {
    const controlsRegion =
      raw.ariaControls.startsWith("region") ||
      raw.ariaExpanded !== "";
    if (controlsRegion && (raw.tagName === "BUTTON" || role === "button"))
      return "accordion";
  }

  return undefined;
}

function fixSelector(sel: string): string {
  if (sel.startsWith("#root > ")) return sel;
  if (sel.startsWith("#root")) return sel;
  return sel;
}
