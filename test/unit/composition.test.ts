import { describe, it, expect } from "vitest";
import {
  inferComposition,
  type ExportInfo,
  type CompositionTree,
} from "../../src/composition.js";
import type { PropSchema } from "../../src/prop-gen.js";

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

// ─── Phase 1: Prefix Grouping ───

describe("Phase 1 — prefix grouping", () => {
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

// ─── Phase 2: Nesting Inference ───

describe("Phase 2 — suffix taxonomy", () => {
  it("builds item-based template: Accordion pattern", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));

    expect(result).not.toBeNull();
    expect(result!.root).toBe("Accordion");
    expect(result!.repeatNode).toBe("AccordionItem");
    expect(result!.repeatCount).toBe(3);

    // Structure: Accordion > Item × 3 > [Trigger, Content]
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

    // Structure: Tabs > [TabsList > TabsTrigger × N, TabsContent × N]
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

    // Trigger is direct child
    const trigger = root.children.find((c) => c.component === "DialogTrigger");
    expect(trigger).toBeDefined();

    // Portal wraps overlay + content
    const portal = root.children.find((c) => c.component === "DialogPortal");
    expect(portal).toBeDefined();

    const overlay = portal!.children.find((c) => c.component === "DialogOverlay");
    expect(overlay).toBeDefined();

    const content = portal!.children.find((c) => c.component === "DialogContent");
    expect(content).toBeDefined();

    // Title, Description, Close inside Content
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

// ─── Template Selection ───

describe("template selection", () => {
  it("selects list-based when *List export exists", () => {
    const names = ["Tabs", "TabsList", "TabsTrigger", "TabsContent"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result).not.toBeNull();
    // List-based: TabsList wraps triggers, content is sibling
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
    // Overlay should be direct child of root
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

// ─── RepeatNode + RepeatCount ───

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
  });

  it("sets repeatNode for flat template with *Item", () => {
    const names = ["RadioGroup", "RadioGroupItem"];
    const exports = makeExports(...names);
    const result = inferComposition(exports, schemasWithChildren(...names));
    expect(result!.repeatNode).toBe("RadioGroupItem");
  });
});

// ─── Props from schemas ───

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

// ─── Determinism ───

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
