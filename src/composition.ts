import type { PropSchema } from "./prop-gen.js";
import type { PropCombination } from "./prop-gen-values.js";

export interface ExportInfo {
  name: string;
  isDefault: boolean;
}

export interface CompositionNode {
  component: string;
  props: PropCombination;
  children: CompositionNode[];
}

export interface CompositionTree {
  root: string;
  structure: CompositionNode[];
  repeatNode?: string;
  repeatCount: number;
}

export type CompositionTemplate = "item-based" | "list-based" | "portal-based" | "flat";

type SuffixRole =
  | "item"
  | "trigger"
  | "content"
  | "title"
  | "description"
  | "list"
  | "overlay"
  | "portal"
  | "close"
  | "footer"
  | "unknown";

const SUFFIX_MAP: [RegExp, SuffixRole][] = [
  [/Item$/i, "item"],
  [/Trigger$/i, "trigger"],
  [/Header$/i, "trigger"],
  [/Label$/i, "trigger"],
  [/Title$/i, "title"],
  [/Content$/i, "content"],
  [/Body$/i, "content"],
  [/Panel$/i, "content"],
  [/Description$/i, "description"],
  [/List$/i, "list"],
  [/Group$/i, "list"],
  [/Overlay$/i, "overlay"],
  [/Backdrop$/i, "overlay"],
  [/Portal$/i, "portal"],
  [/Close$/i, "close"],
  [/Footer$/i, "footer"],
  [/Actions$/i, "footer"],
];

function classifySuffix(name: string, rootName: string): SuffixRole {
  const suffix = name.slice(rootName.length);
  if (!suffix) return "unknown";
  for (const [pattern, role] of SUFFIX_MAP) {
    if (pattern.test(suffix)) return role;
  }
  return "unknown";
}

function findRoot(exports: ExportInfo[]): string | null {
  if (exports.length < 2) return null;

  const names = exports.map((e) => e.name);
  const candidates: string[] = [];

  for (const name of names) {
    const lower = name.toLowerCase();
    const others = names.filter((n) => n !== name);
    if (others.length > 0 && others.every((n) => n.toLowerCase().startsWith(lower))) {
      candidates.push(name);
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

function selectTemplate(roles: Map<string, SuffixRole>): CompositionTemplate {
  const hasListOrGroup = [...roles.values()].some((r) => r === "list");
  const hasItem = [...roles.values()].some((r) => r === "item");
  const hasPortalOrOverlay = [...roles.values()].some((r) => r === "portal" || r === "overlay");

  if (hasListOrGroup) return "list-based";
  if (hasItem) return "item-based";
  if (hasPortalOrOverlay) return "portal-based";
  return "flat";
}

function hasChildrenProp(schemas: Map<string, PropSchema[]>, component: string): boolean {
  const props = schemas.get(component);
  if (!props) return true;
  return props.some((p) => p.name === "children");
}

export function inferComposition(
  exports: ExportInfo[],
  schemas: Map<string, PropSchema[]>,
): CompositionTree | null {
  if (exports.length < 2) return null;

  const rootName = findRoot(exports);
  if (!rootName) return null;

  const nonRoot = exports.filter((e) => e.name !== rootName);
  const roles = new Map<string, SuffixRole>();
  for (const exp of nonRoot) {
    roles.set(exp.name, classifySuffix(exp.name, rootName));
  }

  const template = selectTemplate(roles);
  const repeatCount = 3;

  let tree: CompositionTree;

  switch (template) {
    case "item-based":
      tree = buildItemBased(rootName, nonRoot, roles, schemas, repeatCount);
      break;
    case "list-based":
      tree = buildListBased(rootName, nonRoot, roles, schemas, repeatCount);
      break;
    case "portal-based":
      tree = buildPortalBased(rootName, nonRoot, roles, schemas);
      break;
    case "flat":
      tree = buildFlat(rootName, nonRoot, roles, schemas, repeatCount);
      break;
  }

  return tree;
}

function makeNode(component: string, props: PropCombination = {}, children: CompositionNode[] = []): CompositionNode {
  return { component, props, children };
}

function buildItemBased(
  rootName: string,
  nonRoot: ExportInfo[],
  roles: Map<string, SuffixRole>,
  schemas: Map<string, PropSchema[]>,
  repeatCount: number,
): CompositionTree {
  const itemName = nonRoot.find((e) => roles.get(e.name) === "item")!.name;
  const triggers = nonRoot.filter((e) => roles.get(e.name) === "trigger");
  const contents = nonRoot.filter((e) => roles.get(e.name) === "content");
  const titles = nonRoot.filter((e) => roles.get(e.name) === "title");
  const descriptions = nonRoot.filter((e) => roles.get(e.name) === "description");
  const closes = nonRoot.filter((e) => roles.get(e.name) === "close");
  const footers = nonRoot.filter((e) => roles.get(e.name) === "footer");
  const overlays = nonRoot.filter((e) => roles.get(e.name) === "overlay" || roles.get(e.name) === "portal");
  const unknowns = nonRoot.filter((e) => roles.get(e.name) === "unknown");

  const items: CompositionNode[] = [];
  for (let i = 0; i < repeatCount; i++) {
    const itemChildren: CompositionNode[] = [];
    for (const t of triggers) {
      itemChildren.push(makeNode(t.name, {}, [makeNode("__text__", { text: `Label ${i}` })]));
    }
    for (const c of contents) {
      const contentChildren: CompositionNode[] = [];
      for (const t of titles) contentChildren.push(makeNode(t.name));
      for (const d of descriptions) contentChildren.push(makeNode(d.name));
      for (const cl of closes) contentChildren.push(makeNode(cl.name));
      for (const f of footers) contentChildren.push(makeNode(f.name));
      itemChildren.push(makeNode(c.name, {}, contentChildren));
    }
    items.push(makeNode(itemName, {}, itemChildren));
  }

  const rootChildren: CompositionNode[] = [];
  for (const o of overlays) rootChildren.push(makeNode(o.name));
  rootChildren.push(...items);
  for (const u of unknowns) rootChildren.push(makeNode(u.name));

  return {
    root: rootName,
    structure: [makeNode(rootName, {}, rootChildren)],
    repeatNode: itemName,
    repeatCount,
  };
}

function buildListBased(
  rootName: string,
  nonRoot: ExportInfo[],
  roles: Map<string, SuffixRole>,
  schemas: Map<string, PropSchema[]>,
  repeatCount: number,
): CompositionTree {
  const listName = nonRoot.find((e) => roles.get(e.name) === "list")!.name;
  const triggers = nonRoot.filter((e) => roles.get(e.name) === "trigger");
  const items = nonRoot.filter((e) => roles.get(e.name) === "item");
  const contents = nonRoot.filter((e) => roles.get(e.name) === "content");
  const overlays = nonRoot.filter((e) => roles.get(e.name) === "overlay" || roles.get(e.name) === "portal");
  const unknowns = nonRoot.filter((e) => roles.get(e.name) === "unknown");

  const triggerOrItem = triggers.length > 0 ? triggers : items;

  const listChildren: CompositionNode[] = [];
  for (let i = 0; i < repeatCount; i++) {
    for (const t of triggerOrItem) {
      const hasValue = schemas.get(t.name)?.some((p) => p.name === "value");
      const props: PropCombination = hasValue ? { value: String(i) } : {};
      listChildren.push(makeNode(t.name, props));
    }
  }

  const rootChildren: CompositionNode[] = [];
  for (const o of overlays) rootChildren.push(makeNode(o.name));
  rootChildren.push(makeNode(listName, {}, listChildren));

  for (let i = 0; i < repeatCount; i++) {
    for (const c of contents) {
      const hasValue = schemas.get(c.name)?.some((p) => p.name === "value");
      const props: PropCombination = hasValue ? { value: String(i) } : {};
      rootChildren.push(makeNode(c.name, props));
    }
  }

  for (const u of unknowns) rootChildren.push(makeNode(u.name));

  return {
    root: rootName,
    structure: [makeNode(rootName, { defaultValue: "0" }, rootChildren)],
    repeatCount,
  };
}

function buildPortalBased(
  rootName: string,
  nonRoot: ExportInfo[],
  roles: Map<string, SuffixRole>,
  schemas: Map<string, PropSchema[]>,
): CompositionTree {
  const triggers = nonRoot.filter((e) => roles.get(e.name) === "trigger");
  const portals = nonRoot.filter((e) => roles.get(e.name) === "portal");
  const overlays = nonRoot.filter((e) => roles.get(e.name) === "overlay");
  const contents = nonRoot.filter((e) => roles.get(e.name) === "content");
  const titles = nonRoot.filter((e) => roles.get(e.name) === "title");
  const descriptions = nonRoot.filter((e) => roles.get(e.name) === "description");
  const closes = nonRoot.filter((e) => roles.get(e.name) === "close");
  const footers = nonRoot.filter((e) => roles.get(e.name) === "footer");
  const unknowns = nonRoot.filter((e) => roles.get(e.name) === "unknown");

  const contentChildren: CompositionNode[] = [];
  for (const t of titles) contentChildren.push(makeNode(t.name, {}, [makeNode("__text__", { text: "Title" })]));
  for (const d of descriptions) contentChildren.push(makeNode(d.name, {}, [makeNode("__text__", { text: "Description" })]));
  for (const cl of closes) contentChildren.push(makeNode(cl.name, {}, [makeNode("__text__", { text: "Close" })]));
  for (const f of footers) contentChildren.push(makeNode(f.name));

  const rootChildren: CompositionNode[] = [];

  for (const t of triggers) {
    rootChildren.push(makeNode(t.name, {}, [makeNode("__text__", { text: "Open" })]));
  }

  if (portals.length > 0) {
    const portalChildren: CompositionNode[] = [];
    for (const o of overlays) portalChildren.push(makeNode(o.name));
    for (const c of contents) portalChildren.push(makeNode(c.name, {}, contentChildren));
    rootChildren.push(makeNode(portals[0].name, {}, portalChildren));
  } else {
    for (const o of overlays) rootChildren.push(makeNode(o.name));
    for (const c of contents) rootChildren.push(makeNode(c.name, {}, contentChildren));
  }

  for (const u of unknowns) rootChildren.push(makeNode(u.name));

  return {
    root: rootName,
    structure: [makeNode(rootName, { open: true }, rootChildren)],
    repeatCount: 1,
  };
}

function buildFlat(
  rootName: string,
  nonRoot: ExportInfo[],
  roles: Map<string, SuffixRole>,
  schemas: Map<string, PropSchema[]>,
  repeatCount: number,
): CompositionTree {
  const triggers = nonRoot.filter((e) => roles.get(e.name) === "trigger");
  const contents = nonRoot.filter((e) => roles.get(e.name) === "content");
  const items = nonRoot.filter((e) => roles.get(e.name) === "item");
  const overlays = nonRoot.filter((e) => roles.get(e.name) === "overlay" || roles.get(e.name) === "portal");
  const titles = nonRoot.filter((e) => roles.get(e.name) === "title");
  const descriptions = nonRoot.filter((e) => roles.get(e.name) === "description");
  const closes = nonRoot.filter((e) => roles.get(e.name) === "close");
  const footers = nonRoot.filter((e) => roles.get(e.name) === "footer");
  const unknowns = nonRoot.filter((e) => roles.get(e.name) === "unknown");

  const rootChildren: CompositionNode[] = [];

  for (const o of overlays) rootChildren.push(makeNode(o.name));
  for (const t of triggers) rootChildren.push(makeNode(t.name));

  if (contents.length > 0) {
    const contentChildren: CompositionNode[] = [];
    for (const t of titles) contentChildren.push(makeNode(t.name));
    for (const d of descriptions) contentChildren.push(makeNode(d.name));
    for (let i = 0; i < repeatCount; i++) {
      for (const item of items) {
        const hasValue = schemas.get(item.name)?.some((p) => p.name === "value");
        const props: PropCombination = hasValue ? { value: String(i) } : {};
        contentChildren.push(makeNode(item.name, props));
      }
    }
    for (const cl of closes) contentChildren.push(makeNode(cl.name));
    for (const f of footers) contentChildren.push(makeNode(f.name));
    rootChildren.push(makeNode(contents[0].name, {}, contentChildren));
  } else {
    for (const t of titles) rootChildren.push(makeNode(t.name));
    for (const d of descriptions) rootChildren.push(makeNode(d.name));
    for (let i = 0; i < repeatCount; i++) {
      for (const item of items) {
        const hasValue = schemas.get(item.name)?.some((p) => p.name === "value");
        const props: PropCombination = hasValue ? { value: String(i) } : {};
        rootChildren.push(makeNode(item.name, props));
      }
    }
    for (const cl of closes) rootChildren.push(makeNode(cl.name));
    for (const f of footers) rootChildren.push(makeNode(f.name));
  }

  for (const u of unknowns) rootChildren.push(makeNode(u.name));

  const repeatNode = items.length > 0 ? items[0].name : undefined;

  return {
    root: rootName,
    structure: [makeNode(rootName, {}, rootChildren)],
    repeatNode,
    repeatCount,
  };
}
