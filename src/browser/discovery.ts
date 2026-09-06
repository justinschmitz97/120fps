import type { Page } from "playwright";
import { probePortals } from "./portal-probe.js";

export type InteractionType =
  | "click"
  | "type"
  | "select"
  | "focus"
  | "keyboard"
  | "hover"
  // A scroll container's whole cost model lives in its scroll handler.
  | "scroll";

export type ScrollAxis = "vertical" | "horizontal";

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
  // Present on any overflowing scroll container, even one whose type stayed click or select.
  scrollAxis?: ScrollAxis;
}

export interface DiscoverOptions {
  probePortals?: boolean;
  remount?: () => Promise<void>;
  // Discovery decides what it declines; the caller is what reports the count.
  onSkipped?: (skipped: SkippedTarget[]) => void;
}

export interface RawElement {
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
  scrollAxis: string;
  isContentEditable: boolean;
  isHidden: boolean;
  selector: string;
  inShadow: boolean;
  portal?: boolean;
  // Anchors only: the resolved destination plus the two attributes that redirect a click.
  href?: string;
  linkTarget?: string;
  linkRel?: string;
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

// Why a target was not exercised. The first three are decided before any click; the last two
// are what a click proved after the fact.
export type SkipReason =
  | "external-link"
  | "new-tab-link"
  | "non-http-scheme"
  | "opened-a-page"
  | "left-the-page";

export interface SkippedTarget {
  reason: SkipReason;
  selector: string;
  label: string;
  href?: string;
}

const SKIP_REASON_LABELS: Record<SkipReason, [string, string]> = {
  "external-link": ["external link", "external links"],
  "new-tab-link": ["new-tab link", "new-tab links"],
  "non-http-scheme": ["non-http link", "non-http links"],
  "opened-a-page": ["link that opened a new page", "links that opened a new page"],
  "left-the-page": ["link that left the harness page", "links that left the harness page"],
};

const SKIP_REASON_ORDER = Object.keys(SKIP_REASON_LABELS) as SkipReason[];

function hasRelToken(rel: string | undefined, token: string): boolean {
  return (rel ?? "").toLowerCase().split(/\s+/).includes(token);
}

// A fragment and a same-origin path an app routes itself are the component's own behaviour.
export function classifyNavigationEscape(
  raw: Pick<RawElement, "tagName" | "href" | "linkTarget" | "linkRel">,
  pageOrigin: string,
): SkipReason | undefined {
  if (raw.tagName !== "A") return undefined;
  const href = raw.href ?? "";
  if (href === "") return undefined;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // An href the URL parser refuses does not navigate anywhere either.
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "non-http-scheme";
  if (url.origin !== pageOrigin) return "external-link";
  if (hasRelToken(raw.linkRel, "external")) return "external-link";
  if ((raw.linkTarget ?? "").toLowerCase() === "_blank") return "new-tab-link";
  return undefined;
}

export function partitionExercisableTargets(
  raws: RawElement[],
  pageOrigin: string,
): { exercisable: RawElement[]; skipped: SkippedTarget[] } {
  const exercisable: RawElement[] = [];
  const skipped: SkippedTarget[] = [];
  for (const raw of raws) {
    const reason = classifyNavigationEscape(raw, pageOrigin);
    if (reason === undefined) {
      exercisable.push(raw);
      continue;
    }
    skipped.push({
      reason,
      selector: raw.selector,
      label: raw.textContent.slice(0, 200),
      ...(raw.href ? { href: raw.href } : {}),
    });
  }
  return { exercisable, skipped };
}

// One line, free of per-combo numbers, so a run that skipped the same classes twice prints once.
export const SKIPPED_TARGETS_NOTICE = (skipped: SkippedTarget[]): string | undefined => {
  if (skipped.length === 0) return undefined;
  const classes: string[] = [];
  for (const reason of SKIP_REASON_ORDER) {
    const count = skipped.filter((s) => s.reason === reason).length;
    if (count === 0) continue;
    const [one, many] = SKIP_REASON_LABELS[reason];
    classes.push(`${count} ${count === 1 ? one : many}`);
  }
  const noun = skipped.length === 1 ? "target" : "targets";
  return (
    `explore skipped ${skipped.length} interaction ${noun} that would leave the page ` +
    `(${classes.join(", ")}): a click there measures the browser's navigation, ` +
    "not the component. Same-page links and every other target were exercised as usual."
  );
};

export async function discoverInteractions(
  page: Page,
  options?: DiscoverOptions,
): Promise<InteractionDescriptor[]> {
  const discovered: { elements: RawElement[]; origin: string } = await page.evaluate(() => {
    const results: any[] = [];
    const seen = new Set<Element>();

    const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);
    function scrollAxisOf(el: Element): string {
      const style = window.getComputedStyle(el);
      // Vertical is checked first: it is the axis a wheel drives when both axes scroll.
      if (
        SCROLLABLE_OVERFLOW.has(style.overflowY) &&
        // Content must exceed the box, or every `overflow: auto` wrapper claims a wheel sweep.
        el.scrollHeight > el.clientHeight + 1
      ) {
        return "vertical";
      }
      if (
        SCROLLABLE_OVERFLOW.has(style.overflowX) &&
        el.scrollWidth > el.clientWidth + 1
      ) {
        return "horizontal";
      }
      return "";
    }

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

      const scrollAxis = scrollAxisOf(el);
      const anchor = tag === "A" ? (el as HTMLAnchorElement) : null;

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
        hasOnmouseup ||
        scrollAxis !== "";

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
        scrollAxis,
        isHidden: false,
        selector: hostSelector + " >>> " + shadowSel,
        inShadow: true,
        ...(portalFlag ? { portal: true } : {}),
        ...(anchor
          ? {
              href: anchor.href,
              linkTarget: anchor.getAttribute("target") || "",
              linkRel: anchor.getAttribute("rel") || "",
            }
          : {}),
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
      const scrollAxis = scrollAxisOf(el);
      const anchor = tag === "A" ? (el as HTMLAnchorElement) : null;

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
        hasOnmouseup ||
        scrollAxis !== "";

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
        scrollAxis,
        isHidden: false,
        selector: sel,
        inShadow: false,
        ...(portalFlag ? { portal: true } : {}),
        ...(anchor
          ? {
              href: anchor.href,
              linkTarget: anchor.getAttribute("target") || "",
              linkRel: anchor.getAttribute("rel") || "",
            }
          : {}),
      };
    }

    const SKIP_BODY_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT"]);
    const SKIP_BODY_IDS = new Set(["root"]);

    const rootEl = document.getElementById("root");
    if (rootEl) {
      walkTree(rootEl, "");
    }

    // Portal content renders outside #root, so body children are walked as well.
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof Element)) continue;
      if (SKIP_BODY_TAGS.has(child.tagName)) continue;
      if (child.id && SKIP_BODY_IDS.has(child.id)) continue;
      if (child.tagName.includes("-") && child.tagName.toLowerCase().startsWith("vite")) continue;
      if (seen.has(child)) continue;
      walkTree(child, "", true);
    }

    // A list overflowing the viewport scrolls the document; `:root` names that scrollport.
    const scrollport = document.scrollingElement;
    if (scrollport && scrollport.scrollHeight > scrollport.clientHeight + 1) {
      results.push({
        tagName: "HTML",
        id: "",
        role: "",
        ariaLabel: "",
        ariaControls: "",
        ariaHaspopup: "",
        ariaExpanded: "",
        ariaValueNow: "",
        ariaOrientation: "",
        cursor: "",
        tabindex: null,
        inputType: "",
        textContent: "document",
        dataTestid: "",
        hasOnclick: false,
        hasOnkeydown: false,
        hasOnkeyup: false,
        hasOnkeypress: false,
        hasOnmousedown: false,
        hasOnmouseup: false,
        isContentEditable: false,
        scrollAxis: "vertical",
        isHidden: false,
        selector: ":root",
        inShadow: false,
      });
    }

    return { elements: results, origin: location.origin };
  });

  // An anchor that would leave the page is declined here, before any pattern runs on it.
  const { exercisable, skipped } = partitionExercisableTargets(
    discovered.elements,
    discovered.origin,
  );
  if (skipped.length > 0) options?.onSkipped?.(skipped);

  const rootDescriptors = exercisable.map((raw) => toDescriptor(raw));

  if (!options?.probePortals || !options.remount) {
    return rootDescriptors;
  }

  const portalDescriptors = await probePortals(page, rootDescriptors, options.remount);
  return [...rootDescriptors, ...portalDescriptors];
}

export function toDescriptor(raw: RawElement): InteractionDescriptor {
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
  if (raw.scrollAxis) desc.scrollAxis = raw.scrollAxis as ScrollAxis;

  return desc;
}

// Scroll claims the type only when nothing else does; a listbox's keyboard sweep covers more.
const NATIVE_INTERACTIVE_TAGS = new Set([
  "BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY",
]);

function isScrollOnly(raw: RawElement): boolean {
  if (!raw.scrollAxis) return false;
  if (NATIVE_INTERACTIVE_TAGS.has(raw.tagName)) return false;
  if (raw.role !== "") return false;
  if (raw.isContentEditable) return false;
  return true;
}

function inferType(raw: RawElement): InteractionType {
  const tag = raw.tagName;
  const role = raw.role;

  if (isScrollOnly(raw)) return "scroll";

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
