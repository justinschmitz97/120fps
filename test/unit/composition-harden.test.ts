import { describe, it, expect } from "vitest";
import {
  inferComposition,
  shouldRollbackComposition,
  type ExportInfo,
} from "../../src/props/index.js";
import { compositionToJsx } from "../../src/harness/index.js";
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


describe("H3: multiple components with same role", () => {
  it("handles two title-like components", () => {
    const names = ["Alert", "AlertTitle", "AlertDescription"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const allComponents: string[] = [];
    function collect(node: any) {
      allComponents.push(node.component);
      for (const child of node.children) collect(child);
    }
    collect(root);
    expect(allComponents).toContain("AlertTitle");
    expect(allComponents).toContain("AlertDescription");
  });
});


describe("H4: root export not duplicated in children", () => {
  it("root only appears as outermost wrapper", () => {
    const names = ["Accordion", "AccordionItem"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    expect(root.component).toBe("Accordion");
    const childComponents = root.children.map((c) => c.component);
    expect(childComponents).not.toContain("Accordion");
  });
});


describe("H5: mixed exports with partial prefix sharing", () => {
  it("only groups exports that share a common prefix with root", () => {
    const names = ["Button", "Dialog", "DialogTrigger"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    // findRoot requires a candidate to prefix ALL other exports; Button breaks that for Dialog.
    expect(result).toBeNull();
  });
});


describe("H7: empty schemas map", () => {
  it("still produces valid tree with empty schemas", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const result = inferComposition(makeExports(...names), new Map());
    expect(result).not.toBeNull();
    expect(result!.root).toBe("Accordion");
  });
});


describe("H9: compositionToJsx", () => {
  it("generates JSX for item-based template", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    const jsx = compositionToJsx(result!);
    expect(jsx).toContain("<Accordion>");
    expect(jsx).toContain("<AccordionItem>");
    expect(jsx).toContain("AccordionTrigger");
    expect(jsx).toContain("AccordionContent");
    expect(jsx).toContain("</Accordion>");
  });

  it("generates JSX for list-based template with value props", () => {
    const names = ["Tabs", "TabsList", "TabsTrigger", "TabsContent"];
    const schemas = schemasWithChildren(...names);
    schemas.get("TabsTrigger")!.push({ name: "value", kind: "string", required: true, values: ["test"] });
    schemas.get("TabsContent")!.push({ name: "value", kind: "string", required: true, values: ["test"] });
    const result = inferComposition(makeExports(...names), schemas);
    const jsx = compositionToJsx(result!);
    expect(jsx).toContain("defaultValue");
    expect(jsx).toContain("TabsTrigger");
    expect(jsx).toContain("TabsContent");
  });

  it("generates JSX for portal-based template", () => {
    const names = ["Dialog", "DialogTrigger", "DialogPortal", "DialogOverlay", "DialogContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    const jsx = compositionToJsx(result!);
    expect(jsx).toContain("open");
    expect(jsx).toContain("DialogTrigger");
    expect(jsx).toContain("<DialogPortal>");
    expect(jsx).toContain("DialogOverlay");
    expect(jsx).toContain("DialogContent");
  });

  it("generates self-closing tags for leaf components", () => {
    const names = ["RadioGroup", "RadioGroupItem"];
    const schemas = emptySchemas(...names);
    const result = inferComposition(makeExports(...names), schemas);
    const jsx = compositionToJsx(result!);
    expect(jsx).toContain("<RadioGroupItem />");
  });

  it("returns empty string for empty structure", () => {
    const jsx = compositionToJsx({ root: "X", structure: [], repeatCount: 0 });
    expect(jsx).toBe("");
  });
});


describe("H10: flat without items", () => {
  it("does not set repeatNode when no *Item exists", () => {
    const names = ["Select", "SelectTrigger", "SelectContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    expect(result!.repeatNode).toBeUndefined();
  });
});


describe("H12: list-based with items instead of triggers", () => {
  it("places items inside list when no triggers exist", () => {
    const names = ["ToggleGroup", "ToggleGroupList", "ToggleGroupItem"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const list = root.children.find((c) => c.component === "ToggleGroupList");
    expect(list).toBeDefined();
    const items = list!.children.filter((c) => c.component === "ToggleGroupItem");
    expect(items.length).toBe(3);
  });
});


describe("H15: deeply nested suffixes", () => {
  it("classifies by last matching suffix pattern", () => {
    // Suffix after root "Accordion" is "ItemTrigger", which matches "Trigger" at the end.
    const names = ["Accordion", "AccordionItem", "AccordionItemTrigger", "AccordionContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const items = root.children.filter((c) => c.component === "AccordionItem");
    expect(items.length).toBe(3);
    const firstItem = items[0];
    const triggers = firstItem.children.filter((c) => c.component === "AccordionItemTrigger");
    expect(triggers.length).toBe(1);
  });
});

describe("H20-H22: shouldRollbackComposition guards", () => {
  it("H20 a rendered composed scene is kept even with one element", () => {
    expect(shouldRollbackComposition({ rootElements: 1 })).toBe(false);
  });

  it("H21 a negative element count rolls back", () => {
    expect(shouldRollbackComposition({ rootElements: -1 })).toBe(true);
  });

  it("H22 a null error field does not force a rollback", () => {
    expect(shouldRollbackComposition({ rootElements: 5, error: null })).toBe(false);
  });
});
