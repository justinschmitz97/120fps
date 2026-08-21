import ts from "typescript";
import path from "node:path";
import type { PropSchema } from "./prop-gen.js";
import type { PropCombination } from "./prop-gen-values.js";

export interface ExportInfo {
  name: string;
  isDefault: boolean;
}

// Props of a composition node. `text` is the payload of `__text__` nodes;
// it stays inside props so the serialized tree shape is unchanged.
export type CompositionNodeProps = PropCombination & { text?: string };

export interface CompositionNode {
  component: string;
  props: CompositionNodeProps;
  children: CompositionNode[];
}

export interface CompositionTree {
  root: string;
  structure: CompositionNode[];
  repeatNode?: string;
  repeatCount: number;
}

export type CompositionTemplate = "item-based" | "list-based" | "portal-based" | "flat";

export type SuffixRole =
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

// M80: `classifySuffix` assumes `name` starts with `rootName` (a fixed-length
// slice), which silently misclassifies a bare Radix-convention alias (`List`
// vs root `Tabs`: `"List".slice(4)` is `""`, so it reads as "unknown" even
// though "List" plainly means `list`). Stemming by longest common
// case-insensitive prefix instead classifies correctly whether the candidate
// shares a literal prefix with the root (`TabsList` vs `Tabs`), shares none
// at all (`List` vs `Tabs`), or the root itself carries a suffix the
// candidate does not (`TabsPanel` vs `TabsRoot`, common stem `Tabs`).
// Disclosure-only: `inferComposition` and `classifySuffix` are not called
// from here and are not changed by it.
function classifyByStem(name: string, rootName: string): SuffixRole {
  const lowerName = name.toLowerCase();
  const lowerRoot = rootName.toLowerCase();
  const max = Math.min(lowerName.length, lowerRoot.length);
  let stemLength = 0;
  while (stemLength < max && lowerName[stemLength] === lowerRoot[stemLength]) stemLength++;
  const suffix = name.slice(stemLength);
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

function makeNode(component: string, props: CompositionNodeProps = {}, children: CompositionNode[] = []): CompositionNode {
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
      const props: CompositionNodeProps = hasValue ? { value: String(i) } : {};
      listChildren.push(makeNode(t.name, props));
    }
  }

  const rootChildren: CompositionNode[] = [];
  for (const o of overlays) rootChildren.push(makeNode(o.name));
  rootChildren.push(makeNode(listName, {}, listChildren));

  for (let i = 0; i < repeatCount; i++) {
    for (const c of contents) {
      const hasValue = schemas.get(c.name)?.some((p) => p.name === "value");
      const props: CompositionNodeProps = hasValue ? { value: String(i) } : {};
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
        const props: CompositionNodeProps = hasValue ? { value: String(i) } : {};
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
        const props: CompositionNodeProps = hasValue ? { value: String(i) } : {};
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

export interface CompositionTrial {
  rootElements: number;
  error?: unknown;
}

// Structural inference cannot know a library's nesting rules. A tree that
// mounts to an empty root is not a cheap component, it is a wrong guess, and
// measuring it produces confident numbers about a scene the user never wrote.
export function shouldRollbackComposition(trial: CompositionTrial): boolean {
  if (trial.error !== undefined && trial.error !== null) return true;
  return !(trial.rootElements > 0);
}

export const COMPOSITION_EMPTY_WARNING = (rootName: string): string =>
  `auto-composed scene for ${rootName} rendered no elements; measured the bare export instead. ` +
  `Write a fixture that renders the real composition and pass --fixture <path>.`;

// M80: a sibling part declared by the measured file itself (a same-file
// export, or — base-ui's shape — a same-file type-only relative import) that
// the run never actually composed in.
export interface DeclaredSibling {
  name: string;
  role: SuffixRole;
}

// Fires precisely when: composition was not applied for this run, and the
// file's own exports or same-file type-only relative imports still name at
// least one part the existing SUFFIX_MAP taxonomy recognizes. Deduplicated by
// role, not by name, so radix's prefixed/bare-alias pairs (TabsList and List)
// count once — the first name encountered for a role wins.
export function declaredCompositionSiblings(
  rootName: string,
  siblingExports: ExportInfo[], // same-file exports, resolved root excluded
  typeImportNames: string[], // same-file relative type-only imports
): DeclaredSibling[] {
  const seenRoles = new Set<SuffixRole>();
  const siblings: DeclaredSibling[] = [];
  const candidateNames = [
    ...siblingExports.map((e) => e.name),
    ...typeImportNames,
  ];
  for (const name of candidateNames) {
    if (name === rootName) continue;
    const role = classifyByStem(name, rootName);
    if (role === "unknown" || seenRoles.has(role)) continue;
    seenRoles.add(role);
    siblings.push({ name, role });
  }
  return siblings;
}

export const UNCOMPOSED_SIBLINGS_WARNING = (root: string, siblings: string[]): string =>
  `${root} declares sibling parts (${siblings.join(", ")}) recognized by auto-composition, but ` +
  `none were composed in: every combo measured the bare ${root} export alone. Try --init-fixture ` +
  `to scaffold a fixture, or compose them yourself and pass --fixture.`;

// M80: covers base-ui's shape, where the sibling parts a compound Root
// declares live in adjacent files and never appear as same-file exports —
// only as same-file type-only relative imports (`TabsRoot.tsx`'s `import
// type { TabsTab } from '../tab/TabsTab'`). Collects the local name of every
// `import type { X }` or `import { type X }` specifier whose module
// specifier starts with `.`. Reads the same file `scanExports`-equivalent
// export extraction already opens: no directory walk.
export function scanRelativeTypeImports(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  const names: string[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    if (!node.moduleSpecifier.text.startsWith(".")) return;

    const clause = node.importClause;
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return;

    for (const element of clause.namedBindings.elements) {
      if (clause.isTypeOnly || element.isTypeOnly) {
        names.push(element.name.text);
      }
    }
  });

  return names;
}

export async function extractRelativeTypeImports(filePath: string): Promise<string[]> {
  const absolutePath = path.resolve(filePath);
  const sourceText = ts.sys.readFile(absolutePath);
  if (sourceText === undefined) return [];
  return scanRelativeTypeImports(sourceText, absolutePath);
}

// M91 (commerce-F3): the opposite direction from scanRelativeTypeImports — a
// file's own JSX return can compose a locally-imported component (an
// ordinary value import, not type-only) that the import-graph walk never
// singles out for its own async-ness, because that walk only asks whether
// entries[0] itself is async. Collects the local import actually used as a
// JSX tag, so a caller can hand each one to runPreflight as its own
// entries[0] and reproduce the exact rejection a direct target would get.
// M92: every non-type-only import is collected here, not only a `.`-prefixed
// one -- commerce's real app/page.tsx composes its async children as
// baseUrl-relative bare specifiers ("components/carousel", no leading "./"),
// which a dot-prefix filter here excluded outright. Whether a given
// specifier is actually a local project file (kept) or a real npm dependency
// (not a composed child) needs tsconfig baseUrl/paths context this
// source-only scan does not have; that classification happens at resolution
// time in the caller (analyze.ts's resolveRelativeJsxChild), which excludes
// anything that resolves into node_modules.
export function scanJsxComposedLocalImports(
  sourceText: string,
  fileName: string,
): Array<{ name: string; specifier: string }> {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const localImports = new Map<string, string>();

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    if (clause.name) localImports.set(clause.name.text, node.moduleSpecifier.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        localImports.set(element.name.text, node.moduleSpecifier.text);
      }
    }
  });

  const used = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningLikeElement(node) && ts.isIdentifier(node.tagName)) {
      const specifier = localImports.get(node.tagName.text);
      if (specifier) used.set(node.tagName.text, specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return [...used.entries()].map(([name, specifier]) => ({ name, specifier }));
}

// --- M32 D2: fixture scaffolding ---

export function fixtureScaffoldPath(componentPath: string): string {
  const dot = componentPath.lastIndexOf(".");
  return componentPath.slice(0, dot) + ".fixture" + componentPath.slice(dot);
}

function collectPlaced(nodes: CompositionNode[], seen: Set<string>): void {
  for (const node of nodes) {
    if (node.component !== "__text__") seen.add(node.component);
    collectPlaced(node.children, seen);
  }
}

function renderNode(node: CompositionNode, depth: number): string {
  const pad = "      " + "  ".repeat(depth);
  if (node.component === "__text__") {
    return pad + String((node.props as { text?: unknown }).text ?? "");
  }
  const props = Object.entries(node.props)
    .map(([k, v]) => (typeof v === "string" ? ` ${k}="${v}"` : ` ${k}={${JSON.stringify(v)}}`))
    .join("");
  if (node.children.length === 0) return `${pad}<${node.component}${props} />`;
  const inner = node.children.map((c) => renderNode(c, depth + 1)).join("\n");
  return `${pad}<${node.component}${props}>\n${inner}\n${pad}</${node.component}>`;
}

// The tree auto-composition attempted, written out so the user edits a wrong
// guess instead of starting from an empty file.
export function buildFixtureScaffold(
  stem: string,
  exports: ExportInfo[],
  tree: CompositionTree,
): string {
  const placed = new Set<string>();
  collectPlaced(tree.structure, placed);
  const unplaced = exports.map((e) => e.name).filter((n) => !placed.has(n));

  const names = exports.map((e) => e.name).join(", ");
  const body = tree.structure.map((n) => renderNode(n, 0)).join("\n");

  const todo = unplaced.length > 0
    ? `\n      {/* TODO: place ${unplaced.join(", ")}: auto-composition could not infer where they belong */}`
    : "";

  // A fragment whenever the body is not exactly one element: two siblings
  // under `return (...)` is a syntax error, and the TODO comment counts.
  const needsFragment = tree.structure.length > 1 || todo !== "";
  const inner = needsFragment ? `    <>\n${body}${todo}\n    </>` : `${body}${todo}`;

  // Extensionless: `./x.js` does not resolve to `x.tsx` under every project's
  // moduleResolution, and Vite resolves the bare specifier in all of them.
  return `// Generated by 120fps --init-fixture.
// Auto-composition inferred a tree for ${tree.root} that rendered nothing, so
// the run measured the bare export instead. Edit this file to render the real
// composition, then re-run: the fixture is picked up automatically.
import { ${names} } from "./${stem}";

export default function ${tree.root}Fixture() {
  return (
${inner}
  );
}
`;
}
