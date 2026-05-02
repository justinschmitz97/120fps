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
}

interface RawElement {
  tagName: string;
  id: string;
  role: string;
  ariaLabel: string;
  ariaControls: string;
  ariaHaspopup: string;
  ariaExpanded: string;
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
              const raw = extractRaw(node, root, selectorPrefix);
              if (raw) results.push(raw);
            }
          }

          if ((node as any).shadowRoot) {
            const shadow = (node as any).shadowRoot as ShadowRoot;
            const hostSelector =
              selectorPrefix + getSelector(node, root);
            walkShadow(shadow, hostSelector);
          }
        }
        node = walker.nextNode() as Element | null;
      }
    }

    function walkShadow(shadow: ShadowRoot, hostSelector: string) {
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
              const raw = extractRawShadow(node, shadow, hostSelector);
              if (raw) results.push(raw);
            }
          }
          if ((node as any).shadowRoot) {
            const innerShadow = (node as any).shadowRoot as ShadowRoot;
            const sel = hostSelector + " >>> " + getShadowSelector(node, shadow);
            walkShadow(innerShadow, sel);
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
      };
    }

    function extractRaw(
      el: Element,
      root: Element | ShadowRoot,
      selectorPrefix: string,
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

      const nonInteractiveRoles = new Set([
        "tablist",
        "menu",
        "tree",
        "region",
        "tabpanel",
        "dialog",
      ]);
      if (
        role &&
        nonInteractiveRoles.has(role) &&
        tag !== "BUTTON" &&
        tag !== "A" &&
        tag !== "INPUT" &&
        tag !== "TEXTAREA" &&
        tag !== "SELECT" &&
        tag !== "SUMMARY" &&
        tabindex === null &&
        !isContentEditable &&
        !hasOnclick
      ) {
        return null;
      }

      const sel = selectorPrefix + getSelector(el, root);

      return {
        tagName: tag,
        id: el.id,
        role,
        ariaLabel: el.getAttribute("aria-label") || "",
        ariaControls: el.getAttribute("aria-controls") || "",
        ariaHaspopup: el.getAttribute("aria-haspopup") || "",
        ariaExpanded: el.getAttribute("aria-expanded") || "",
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
      };
    }

    const rootEl = document.getElementById("root");
    if (rootEl) {
      walkTree(rootEl, "");
    }

    return results;
  });

  return rawElements.map((raw) => toDescriptor(raw));
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
