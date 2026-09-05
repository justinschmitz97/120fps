import { describe, it, expect } from "vitest";
import {
  inferComposition,
  declaredCompositionSiblings,
  scanRelativeTypeImports,
  UNCOMPOSED_SIBLINGS_WARNING,
  type ExportInfo,
  type CompositionTree,
} from "../../src/props/index.js";
import type { PropSchema } from "../../src/props/index.js";

function makeExports(...names: string[]): ExportInfo[] {
  return names.map((name, i) => ({ name, isDefault: i === 0 }));
}

function emptySchemas(...names: string[]): Map<string, PropSchema[]> {
  const map = new Map<string, PropSchema[]>();
  for (const name of names) map.set(name, []);
  return map;
}

function schemasWithChildren(...names: string[]): Map<string, PropSchema[]> {
  const map = new Map<string, PropSchema[]>();
  for (const name of names) {
    map.set(name, [{ name: "children", kind: "reactnode", required: false, values: [] }]);
  }
  return map;
}


describe("Phase 1: prefix grouping", () => {
  it("identifies root as shortest shared prefix among exports", () => {
    const exports = makeExports("Dialog", "DialogTrigger", "DialogContent");
    const result = inferComposition(exports, emptySchemas("Dialog", "DialogTrigger", "DialogContent"));
    expect(result).not.toBeNull();
    expect(result!.root).toBe("Dialog");
  });

  it("returns null for single export", () => {
    const exports = makeExports("Button");
    const result = inferComposition(exports, emptySchemas("Button"));
    expect(result).toBeNull();
  });

  it("returns null when no shared prefix exists", () => {
    const exports = makeExports("Button", "Input", "Label");
    const result = inferComposition(exports, emptySchemas("Button", "Input", "Label"));
    expect(result).toBeNull();
  });

  it("picks shortest when multiple prefix candidates exist", () => {
    const exports = makeExports("Tab", "TabList", "TabListItem", "TabPanel");
    const result = inferComposition(exports, emptySchemas("Tab", "TabList", "TabListItem", "TabPanel"));
    expect(result).not.toBeNull();
    expect(result!.root).toBe("Tab");
  });

  it("requires root to be an exact export name", () => {
    // "Dia" is a prefix of both but not an export
    const exports = makeExports("DialogBox", "DialogBoxTrigger");
    const result = inferComposition(exports, emptySchemas("DialogBox", "DialogBoxTrigger"));
    expect(result).not.toBeNull();
    expect(result!.root).toBe("DialogBox");
  });

  it("uses case-insensitive prefix matching", () => {
    const exports = makeExports("dialog", "DialogTrigger", "DialogContent");
    const result = inferComposition(exports, emptySchemas("dialog", "DialogTrigger", "DialogContent"));
    expect(result).not.toBeNull();
    expect(result!.root).toBe("dialog");
  });

  it("requires at least 2 exports sharing the prefix", () => {
    const exports = makeExports("Foo", "BarBaz");
    const result = inferComposition(exports, emptySchemas("Foo", "BarBaz"));
    expect(result).toBeNull();
  });
});


describe("Phase 2: suffix taxonomy", () => {
  it("builds item-based template: Accordion pattern", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    expect(result!.root).toBe("Accordion");
    expect(result!.repeatNode).toBe("AccordionItem");
    expect(result!.repeatCount).toBe(3);

    const root = result!.structure[0];
    expect(root.component).toBe("Accordion");
    expect(root.children.length).toBe(3);

    const item = root.children[0];
    expect(item.component).toBe("AccordionItem");
    expect(item.children.length).toBe(2);
    expect(item.children[0].component).toBe("AccordionTrigger");
    expect(item.children[1].component).toBe("AccordionContent");
  });

  it("builds list-based template: Tabs pattern", () => {
    const names = ["Tabs", "TabsList", "TabsTrigger", "TabsContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    expect(result!.root).toBe("Tabs");

    const root = result!.structure[0];
    expect(root.component).toBe("Tabs");

    const list = root.children.find((c) => c.component === "TabsList");
    expect(list).toBeDefined();
    const triggers = list!.children.filter((c) => c.component === "TabsTrigger");
    expect(triggers.length).toBe(3);

    const contents = root.children.filter((c) => c.component === "TabsContent");
    expect(contents.length).toBe(3);
  });

  it("builds portal-based template: Dialog pattern", () => {
    const names = [
      "Dialog", "DialogTrigger", "DialogPortal", "DialogOverlay",
      "DialogContent", "DialogTitle", "DialogDescription", "DialogClose",
    ];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    expect(result!.root).toBe("Dialog");

    const root = result!.structure[0];
    expect(root.component).toBe("Dialog");

    const trigger = root.children.find((c) => c.component === "DialogTrigger");
    expect(trigger).toBeDefined();

    const portal = root.children.find((c) => c.component === "DialogPortal");
    expect(portal).toBeDefined();

    const overlay = portal!.children.find((c) => c.component === "DialogOverlay");
    expect(overlay).toBeDefined();

    const content = portal!.children.find((c) => c.component === "DialogContent");
    expect(content).toBeDefined();

    expect(content!.children.find((c) => c.component === "DialogTitle")).toBeDefined();
    expect(content!.children.find((c) => c.component === "DialogDescription")).toBeDefined();
    expect(content!.children.find((c) => c.component === "DialogClose")).toBeDefined();
  });

  it("builds flat template: RadioGroup pattern", () => {
    const names = ["RadioGroup", "RadioGroupItem"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    expect(result!.root).toBe("RadioGroup");

    const root = result!.structure[0];
    expect(root.component).toBe("RadioGroup");
    const items = root.children.filter((c) => c.component === "RadioGroupItem");
    expect(items.length).toBe(3);
  });

  it("places unrecognized suffix as direct child of root", () => {
    const names = ["Menu", "MenuCustomWidget"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    const root = result!.structure[0];
    expect(root.children.find((c) => c.component === "MenuCustomWidget")).toBeDefined();
  });

  it("places overlay/backdrop before other children", () => {
    const names = ["Dialog", "DialogOverlay", "DialogContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    const root = result!.structure[0];
    expect(root.children[0].component).toBe("DialogOverlay");
  });

  it("handles *Close suffix inside Content", () => {
    const names = ["Sheet", "SheetContent", "SheetClose"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const content = root.children.find((c) => c.component === "SheetContent");
    expect(content).toBeDefined();
    expect(content!.children.find((c) => c.component === "SheetClose")).toBeDefined();
  });

  it("handles *Footer and *Actions inside Content", () => {
    const names = ["Dialog", "DialogContent", "DialogFooter"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const content = root.children.find((c) => c.component === "DialogContent");
    expect(content).toBeDefined();
    expect(content!.children.find((c) => c.component === "DialogFooter")).toBeDefined();
  });
});


describe("template selection", () => {
  it("selects list-based when *List export exists", () => {
    const names = ["Tabs", "TabsList", "TabsTrigger", "TabsContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const list = root.children.find((c) => c.component === "TabsList");
    expect(list).toBeDefined();
  });

  it("selects list-based when *Group export exists", () => {
    const names = ["Toggle", "ToggleGroup", "ToggleGroupItem"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const group = root.children.find((c) => c.component === "ToggleGroup");
    expect(group).toBeDefined();
  });

  it("selects item-based when *Item exists without *List", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result).not.toBeNull();
    expect(result!.repeatNode).toBe("AccordionItem");
  });

  it("selects portal-based when *Portal export exists", () => {
    const names = ["Popover", "PopoverTrigger", "PopoverPortal", "PopoverContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const portal = root.children.find((c) => c.component === "PopoverPortal");
    expect(portal).toBeDefined();
  });

  it("selects portal-based when *Overlay exists without *Portal", () => {
    const names = ["AlertDialog", "AlertDialogTrigger", "AlertDialogOverlay", "AlertDialogContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    expect(root.children.find((c) => c.component === "AlertDialogOverlay")).toBeDefined();
  });

  it("selects flat when no *Item, *List, *Portal, or *Overlay", () => {
    const names = ["Select", "SelectTrigger", "SelectContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    expect(root.children.find((c) => c.component === "SelectTrigger")).toBeDefined();
    expect(root.children.find((c) => c.component === "SelectContent")).toBeDefined();
  });
});


describe("repeatNode and repeatCount", () => {
  it("sets repeatNode to *Item component when item-based", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result!.repeatNode).toBe("AccordionItem");
  });

  it("uses default repeatCount of 3", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result!.repeatCount).toBe(3);
  });

  it("does not set repeatNode for portal-based template", () => {
    const names = ["Dialog", "DialogTrigger", "DialogPortal", "DialogContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result!.repeatNode).toBeUndefined();

    const root = result!.structure[0];
    const portal = root.children.find((c) => c.component === "DialogPortal");
    expect(portal).toBeDefined();
    const content = portal!.children.find((c) => c.component === "DialogContent");
    expect(content).toBeDefined();
    expect(content!.children).toHaveLength(0);
  });

  it("sets repeatNode for flat template with *Item", () => {
    const names = ["RadioGroup", "RadioGroupItem"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result!.repeatNode).toBe("RadioGroupItem");
  });
});


describe("props from schemas", () => {
  it("marks components without children prop as leaves", () => {
    const names = ["Menu", "MenuItem"];
    const exports = makeExports(...names);
    const schemas = new Map<string, PropSchema[]>();
    schemas.set("Menu", [{ name: "children", kind: "reactnode", required: false, values: [] }]);
    schemas.set("MenuItem", [{ name: "label", kind: "string", required: true, values: ["test"] }]);

    const result = inferComposition(exports, schemas);
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const item = root.children[0];
    expect(item.children).toHaveLength(0);
  });

  it("populates value prop on repeated items with index", () => {
    const names = ["Tabs", "TabsList", "TabsTrigger", "TabsContent"];
    const exports = makeExports(...names);
    const schemas = schemasWithChildren(...names);
    schemas.get("TabsTrigger")!.push({ name: "value", kind: "string", required: true, values: ["test"] });
    schemas.get("TabsContent")!.push({ name: "value", kind: "string", required: true, values: ["test"] });

    const result = inferComposition(exports, schemas);
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const list = root.children.find((c) => c.component === "TabsList");
    expect(list).toBeDefined();
    const triggers = list!.children.filter((c) => c.component === "TabsTrigger");
    for (let i = 0; i < triggers.length; i++) {
      expect(triggers[i].props.value).toBe(String(i));
    }
  });
});


describe("declaredCompositionSiblings: radix shape (same-file bare aliases)", () => {
  it("finds sibling roles from prefixed exports and bare Radix aliases, deduped by role", () => {
    // radix's tabs.tsx exports both the prefixed family and bare Radix-convention aliases.
    const siblingExports: ExportInfo[] = [
      { name: "TabsList", isDefault: false },
      { name: "TabsTrigger", isDefault: false },
      { name: "TabsContent", isDefault: false },
      { name: "Root", isDefault: false },
      { name: "List", isDefault: false },
      { name: "Trigger", isDefault: false },
      { name: "Content", isDefault: false },
    ];
    const siblings = declaredCompositionSiblings("Tabs", siblingExports, []);
    const roles = siblings.map((s) => s.role).sort();
    expect(roles).toEqual(["content", "list", "trigger"]);
    // First-seen name wins per role: the prefixed export precedes its bare alias in the list.
    expect(siblings.find((s) => s.role === "list")?.name).toBe("TabsList");
    expect(siblings.find((s) => s.role === "trigger")?.name).toBe("TabsTrigger");
    expect(siblings.find((s) => s.role === "content")?.name).toBe("TabsContent");
    // "Root" is a bare alias of Tabs itself, not a sibling part, and must not appear.
    expect(siblings.find((s) => s.name === "Root")).toBeUndefined();
  });

  it("classifies a bare alias by its own name even with zero shared prefix with the root", () => {
    // classifySuffix's fixed-length slice would misread "List" against a 4-char root as unknown.
    const siblings = declaredCompositionSiblings("Tabs", [{ name: "List", isDefault: false }], []);
    expect(siblings).toEqual([{ name: "List", role: "list" }]);
  });
});

describe("declaredCompositionSiblings: base-ui shape (single export, parts in adjacent files)", () => {
  it("surfaces sibling roles from same-file type-only relative imports alone", () => {
    // A type-only relative import counts as evidence too; "Tab" isn't a suffix, "Panel" is.
    const siblings = declaredCompositionSiblings("TabsRoot", [], ["TabsTab", "TabsPanel"]);
    expect(siblings).toEqual([{ name: "TabsPanel", role: "content" }]);
    expect(siblings.find((s) => s.name === "TabsTab")).toBeUndefined();
  });

  it("never names TabsList or TabsIndicator: they are not imported even for their types", () => {
    // Cross-file sibling discovery beyond a same-file type-only import is out of scope.
    const siblings = declaredCompositionSiblings("TabsRoot", [], ["TabsTab", "TabsPanel"]);
    expect(siblings.map((s) => s.name)).not.toContain("TabsList");
    expect(siblings.map((s) => s.name)).not.toContain("TabsIndicator");
  });
});

describe("declaredCompositionSiblings: control case (single-part leaf)", () => {
  it("returns [] for radix's separator.tsx shape: Root classifies as unknown, same as classifySuffix", () => {
    // separator.tsx exports only Separator/Root; Root matches no recognized SUFFIX_MAP suffix.
    const siblings = declaredCompositionSiblings("Separator", [{ name: "Root", isDefault: false }], []);
    expect(siblings).toEqual([]);
  });
});

describe("scanRelativeTypeImports", () => {
  it("collects local names from `import type { X }` with a relative specifier", () => {
    const source = `
      import type { TabsTab } from '../tab/TabsTab';
      import type { TabsPanel } from '../panel/TabsPanel';
      export function TabsRoot() { return null; }
    `;
    expect(scanRelativeTypeImports(source, "TabsRoot.tsx")).toEqual(["TabsTab", "TabsPanel"]);
  });

  it("collects local names from `import { type X }` inline type specifiers", () => {
    const source = `import { type Foo, Bar } from './sibling';`;
    expect(scanRelativeTypeImports(source, "x.tsx")).toEqual(["Foo"]);
  });

  it("ignores type imports from bare (non-relative) module specifiers", () => {
    const source = `import type { ReactNode } from 'react';`;
    expect(scanRelativeTypeImports(source, "x.tsx")).toEqual([]);
  });

  it("ignores value (non-type) relative imports", () => {
    const source = `import { Foo } from './sibling';`;
    expect(scanRelativeTypeImports(source, "x.tsx")).toEqual([]);
  });
});

describe("UNCOMPOSED_SIBLINGS_WARNING", () => {
  it("names the root, its siblings, and points at --init-fixture and --fixture", () => {
    const warning = UNCOMPOSED_SIBLINGS_WARNING("Tabs", ["TabsList", "TabsTrigger", "TabsContent"]);
    expect(warning).toContain("Tabs");
    expect(warning).toContain("TabsList, TabsTrigger, TabsContent");
    expect(warning).toContain("--init-fixture");
    expect(warning).toContain("--fixture");
  });
});


describe("determinism", () => {
  it("produces same tree for same inputs", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const exports = makeExports(...names);
    const schemas = schemasWithChildren(...names);

    const r1 = inferComposition(exports, schemas);
    const r2 = inferComposition(exports, schemas);
    expect(r1).toEqual(r2);
  });
});
