import { describe, it, expect } from "vitest";
import {
  inferComposition,
  type ExportInfo,
} from "../../src/composition.js";
import { compositionToJsx } from "../../src/harness.js";
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

// ─── H1: Unrecognized suffix → direct child of root ───

describe("H1: unrecognized suffix", () => {
  it("places DialogSub as direct child of root", () => {
    const names = ["Dialog", "DialogTrigger", "DialogSub"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    expect(root.children.find((c) => c.component === "DialogSub")).toBeDefined();
  });

  it("places SelectValue as direct child of root", () => {
    const names = ["Select", "SelectTrigger", "SelectValue", "SelectContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    expect(root.children.find((c) => c.component === "SelectValue")).toBeDefined();
  });
});

// ─── H3: Two items share similar suffix ───

describe("H3: multiple components with same role", () => {
  it("handles two title-like components", () => {
    const names = ["Alert", "AlertTitle", "AlertDescription"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    // Both should appear somewhere in the tree
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

// ─── H4: Root not duplicated in children ───

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

// ─── H5: Mixed exports with partial shared prefix ───

describe("H5: mixed exports with partial prefix sharing", () => {
  it("only groups exports that share a common prefix with root", () => {
    // "Dialog" is prefix of DialogTrigger, but not Button
    // findRoot should find Dialog (shortest prefix of at least 1 other)
    const names = ["Button", "Dialog", "DialogTrigger"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    // Dialog is root prefix of DialogTrigger, Button doesn't share prefix
    // But findRoot checks which export name is prefix of ALL others — Button breaks this
    // So this should return null since no single export is prefix of all others
    expect(result).toBeNull();
  });

  it("succeeds when all exports share common prefix", () => {
    const names = ["Dialog", "DialogTrigger", "DialogContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    expect(result!.root).toBe("Dialog");
  });
});

// ─── H7: Empty schemas map ───

describe("H7: empty schemas map", () => {
  it("still produces valid tree with empty schemas", () => {
    const names = ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"];
    const result = inferComposition(makeExports(...names), new Map());
    expect(result).not.toBeNull();
    expect(result!.root).toBe("Accordion");
  });
});

// ─── H9: compositionToJsx generates valid JSX ───

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

// ─── H10: Flat template without items → no repeatNode ───

describe("H10: flat without items", () => {
  it("does not set repeatNode when no *Item exists", () => {
    const names = ["Select", "SelectTrigger", "SelectContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    expect(result!.repeatNode).toBeUndefined();
  });
});

// ─── H11: Portal template without optional sub-components ───

describe("H11: minimal portal template", () => {
  it("generates valid tree without Title/Description/Close", () => {
    const names = ["Dialog", "DialogTrigger", "DialogContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    // Since no Portal/Overlay, this is flat template
    expect(root.children.find((c) => c.component === "DialogTrigger")).toBeDefined();
    expect(root.children.find((c) => c.component === "DialogContent")).toBeDefined();
  });

  it("generates valid tree with Portal but without Overlay", () => {
    const names = ["Dialog", "DialogTrigger", "DialogPortal", "DialogContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const portal = root.children.find((c) => c.component === "DialogPortal");
    expect(portal).toBeDefined();
    const content = portal!.children.find((c) => c.component === "DialogContent");
    expect(content).toBeDefined();
    expect(content!.children).toHaveLength(0);
  });
});

// ─── H12: List-based with items but no triggers ───

describe("H12: list-based with items instead of triggers", () => {
  it("places items inside list when no triggers exist", () => {
    const names = ["ToggleGroup", "ToggleGroupList", "ToggleGroupItem"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    const root = result!.structure[0];
    const list = root.children.find((c) => c.component === "ToggleGroupList");
    expect(list).toBeDefined();
    // Items should be inside list when no triggers
    const items = list!.children.filter((c) => c.component === "ToggleGroupItem");
    expect(items.length).toBe(3);
  });
});

// ─── H14: Single component file ───

describe("H14: single component", () => {
  it("returns null for single export", () => {
    const result = inferComposition(
      [{ name: "Button", isDefault: false }],
      emptySchemas("Button"),
    );
    expect(result).toBeNull();
  });
});

// ─── H15: Nested suffixes ───

describe("H15: deeply nested suffixes", () => {
  it("classifies by last matching suffix pattern", () => {
    // "AccordionItemTrigger" — suffix after root "Accordion" is "ItemTrigger"
    // This matches "Trigger" at end → trigger role
    const names = ["Accordion", "AccordionItem", "AccordionItemTrigger", "AccordionContent"];
    const result = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(result).not.toBeNull();
    // AccordionItemTrigger should be classified as trigger and placed inside items
    const root = result!.structure[0];
    const items = root.children.filter((c) => c.component === "AccordionItem");
    expect(items.length).toBe(3);
    const firstItem = items[0];
    const triggers = firstItem.children.filter((c) => c.component === "AccordionItemTrigger");
    expect(triggers.length).toBe(1);
  });
});
