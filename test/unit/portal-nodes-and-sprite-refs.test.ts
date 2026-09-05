import { describe, it, expect } from "vitest";
import {
  COMPONENT_NODE_COUNT_SOURCE,
  UNRESOLVED_SPRITE_REFS_SOURCE,
  COMPONENT_NODE_COUNT_EXPRESSION,
  UNRESOLVED_SPRITE_REFS_EXPRESSION,
} from "../../src/browser/index.js";

interface FakeElement {
  tagName: string;
  localName: string;
  children?: FakeElement[];
  descendants?: FakeElement[];
  attrs?: Record<string, string>;
}

function el(tagName: string, extra: Partial<FakeElement> = {}): FakeElement {
  return {
    tagName: tagName.toUpperCase(),
    localName: tagName.toLowerCase(),
    children: [],
    descendants: [],
    ...extra,
  };
}

function fakeDocument(root: FakeElement | null, bodyChildren: FakeElement[], ids: string[] = []) {
  // #root must be the same object whether reached via root or body.children, as in a real document.
  const wrapped = new Map<FakeElement, unknown>();
  const withQuery = (node: FakeElement): unknown => {
    const existing = wrapped.get(node);
    if (existing) return existing;
    const value = {
      ...node,
      querySelectorAll: () => (node.descendants ?? []).map(withQuery),
      getAttribute: (name: string) => node.attrs?.[name] ?? null,
    };
    wrapped.set(node, value);
    return value;
  };
  const wrappedRoot = root ? withQuery(root) : null;
  return {
    getElementById: (id: string) =>
      id === "root" ? wrappedRoot : ids.includes(id) ? {} : null,
    body: { children: bodyChildren.map(withQuery) },
    __root: wrappedRoot,
    querySelectorAll: () => [],
  };
}

function loadCounter(): (doc: unknown) => { rootNodes: number; orphanNodes: number } {
  return new Function(
    `${COMPONENT_NODE_COUNT_SOURCE}\nreturn __120fpsCountComponentNodes;`,
  )() as (doc: unknown) => { rootNodes: number; orphanNodes: number };
}

function loadSpriteProbe(): (doc: unknown) => string[] {
  return new Function(
    `${UNRESOLVED_SPRITE_REFS_SOURCE}\nreturn __120fpsUnresolvedSpriteRefs;`,
  )() as (doc: unknown) => string[];
}

// dub-F6: the total count can't say whether nodes rendered into #root or only a portal.
describe("counting what the component rendered", () => {
  it("splits nodes under the root from nodes rendered outside it", () => {
    const count = loadCounter();
    const doc = fakeDocument(
      el("div", { descendants: [el("span"), el("b")] }),
      [el("div", { descendants: [el("p")] })],
    );
    expect(count(doc)).toEqual({ rootNodes: 2, orphanNodes: 2 });
  });

  it("keeps the sum every existing caller reads", () => {
    const count = loadCounter();
    const doc = fakeDocument(
      el("div", { descendants: [el("span")] }),
      [el("div", { descendants: [el("p"), el("i")] })],
    );
    const { rootNodes, orphanNodes } = count(doc);
    expect(rootNodes + orphanNodes).toBe(4);
  });

  it("ignores the harness's own script, style and vite elements", () => {
    const count = loadCounter();
    const doc = fakeDocument(el("div", { descendants: [] }), [
      el("script"),
      el("style"),
      el("vite-error-overlay"),
    ]);
    expect(count(doc)).toEqual({ rootNodes: 0, orphanNodes: 0 });
  });

  it("counts nothing when the root is missing and the body is empty", () => {
    const count = loadCounter();
    const doc = fakeDocument(null, []);

    expect(count(doc)).toEqual({ rootNodes: 0, orphanNodes: 0 });
  });

  it("does not count the root element itself as an orphan", () => {
    const count = loadCounter();
    const root = el("div", { descendants: [el("span")] });
    const doc = fakeDocument(root, [root]);
    expect(count(doc).orphanNodes).toBe(0);
  });
});

// calcom-F5: sprite refs to shell defs render empty with no request, invisible to network probes.
describe("sprite references the document cannot resolve", () => {
  it("names a same-document fragment whose target is absent", () => {
    const probe = loadSpriteProbe();
    const use = el("use", { attrs: { href: "#calendar" } });
    const doc = fakeDocument(el("div", { descendants: [el("svg"), use] }), []);
    expect(probe(doc)).toEqual(["#calendar"]);
  });

  it("says nothing when the sprite is in the document", () => {
    const probe = loadSpriteProbe();
    const use = el("use", { attrs: { href: "#calendar" } });
    const doc = fakeDocument(el("div", { descendants: [use] }), [], ["calendar"]);
    expect(probe(doc)).toEqual([]);
  });

  it("reads the legacy xlink:href form", () => {
    const probe = loadSpriteProbe();
    const use = el("use", { attrs: { "xlink:href": "#legacy" } });
    const doc = fakeDocument(el("div", { descendants: [use] }), []);
    expect(probe(doc)).toEqual(["#legacy"]);
  });

  it("leaves an external sprite URL alone", () => {
    const probe = loadSpriteProbe();
    const use = el("use", { attrs: { href: "/icons.svg#calendar" } });
    const doc = fakeDocument(el("div", { descendants: [use] }), []);
    expect(probe(doc)).toEqual([]);
  });

  it("reports each missing id once", () => {
    const probe = loadSpriteProbe();
    const doc = fakeDocument(
      el("div", {
        descendants: [
          el("use", { attrs: { href: "#calendar" } }),
          el("use", { attrs: { href: "#calendar" } }),
          el("use", { attrs: { href: "#clock" } }),
        ],
      }),
      [],
    );
    expect(probe(doc)).toEqual(["#calendar", "#clock"]);
  });

  it("looks inside portal content as well as the root", () => {
    const probe = loadSpriteProbe();
    const doc = fakeDocument(el("div", { descendants: [] }), [
      el("div", { descendants: [el("use", { attrs: { href: "#portal-icon" } })] }),
    ]);
    expect(probe(doc)).toEqual(["#portal-icon"]);
  });

  it("ignores a use element with no reference at all", () => {
    const probe = loadSpriteProbe();
    const doc = fakeDocument(el("div", { descendants: [el("use")] }), []);
    expect(probe(doc)).toEqual([]);
  });
});

// A leading "function" parses under new Function but fails as a page.evaluate expression.
describe("what is handed to page.evaluate", () => {
  const parses = (expression: string): boolean => {
    try {
      new Function(`return (${expression});`);
      return true;
    } catch {
      return false;
    }
  };

  it("parses the node count as a single expression", () => {
    expect(parses(COMPONENT_NODE_COUNT_EXPRESSION)).toBe(true);
  });

  it("parses the sprite probe as a single expression", () => {
    expect(parses(UNRESOLVED_SPRITE_REFS_EXPRESSION)).toBe(true);
  });

  it("does not hand over a bare function declaration", () => {
    expect(parses(`${COMPONENT_NODE_COUNT_SOURCE}
__120fpsCountComponentNodes(document)`)).toBe(
      false,
    );
  });

  it("evaluates to the counter's own answer", () => {
    const doc = fakeDocument(el("div", { descendants: [el("span")] }), []);
    const run = new Function("document", `return (${COMPONENT_NODE_COUNT_EXPRESSION});`) as (
      d: unknown,
    ) => { rootNodes: number; orphanNodes: number };

    expect(run(doc)).toEqual({ rootNodes: 1, orphanNodes: 0 });
  });

  it("evaluates to the sprite probe's own answer", () => {
    const doc = fakeDocument(
      el("div", { descendants: [el("use", { attrs: { href: "#gone" } })] }),
      [],
    );
    const run = new Function("document", `return (${UNRESOLVED_SPRITE_REFS_EXPRESSION});`) as (
      d: unknown,
    ) => string[];

    expect(run(doc)).toEqual(["#gone"]);
  });
});
