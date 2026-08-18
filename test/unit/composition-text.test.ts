import { describe, it, expect } from "vitest";
import {
  inferComposition,
  type CompositionNode,
  type ExportInfo,
} from "../../src/composition.js";
import { compositionToJsx } from "../../src/harness.js";
import type { PropSchema } from "../../src/prop-gen.js";

function makeExports(...names: string[]): ExportInfo[] {
  return names.map((name, i) => ({ name, isDefault: i === 0 }));
}

function schemasWithChildren(...names: string[]): Map<string, PropSchema[]> {
  const map = new Map<string, PropSchema[]>();
  for (const name of names) {
    map.set(name, [
      { name: "children", kind: "reactnode", required: false, values: [] },
    ]);
  }
  return map;
}

function collectTextNodes(node: CompositionNode, out: CompositionNode[]): void {
  if (node.component === "__text__") out.push(node);
  for (const child of node.children) collectTextNodes(child, out);
}

describe("CompositionNode.text typing", () => {
  it("text nodes carry a typed string under props.text", () => {
    const names = ["Dialog", "DialogTrigger", "DialogPortal", "DialogContent", "DialogTitle"];
    const tree = inferComposition(makeExports(...names), schemasWithChildren(...names));
    expect(tree).not.toBeNull();

    const textNodes: CompositionNode[] = [];
    for (const node of tree!.structure) collectTextNodes(node, textNodes);
    expect(textNodes.length).toBeGreaterThan(0);
    for (const node of textNodes) {
      // typed access: no cast; compile failure here means the D9 shape regressed
      const text: string | undefined = node.props.text;
      expect(typeof text).toBe("string");
    }
  });

  it("JSON shape is unchanged: text lives under props, not on the node", () => {
    const names = ["Dialog", "DialogTrigger", "DialogPortal", "DialogContent", "DialogTitle"];
    const tree = inferComposition(makeExports(...names), schemasWithChildren(...names));
    const roundTripped = JSON.parse(JSON.stringify(tree));

    const textNodes: CompositionNode[] = [];
    for (const node of roundTripped.structure as CompositionNode[]) {
      collectTextNodes(node, textNodes);
    }
    expect(textNodes.length).toBeGreaterThan(0);
    for (const node of textNodes) {
      expect(Object.keys(node)).toEqual(["component", "props", "children"]);
      expect(typeof node.props.text).toBe("string");
    }
  });

  it("nodeToJsx renders text nodes as JSON string literals", () => {
    const tree = {
      root: "Card",
      structure: [
        {
          component: "Card",
          props: {},
          children: [
            { component: "__text__", props: { text: 'He said "hi"' }, children: [] },
          ],
        },
      ],
      repeatCount: 1,
    };
    const jsx = compositionToJsx(tree);
    expect(jsx).toContain(JSON.stringify('He said "hi"'));
  });

  it("nodeToJsx renders empty string for a text node without text", () => {
    const tree = {
      root: "Card",
      structure: [
        {
          component: "Card",
          props: {},
          children: [{ component: "__text__", props: {}, children: [] }],
        },
      ],
      repeatCount: 1,
    };
    const jsx = compositionToJsx(tree);
    expect(jsx).toContain('""');
  });
});
