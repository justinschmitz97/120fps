import { describe, it, expect } from "vitest";
import { hintsForMountAbort, formatHints } from "../../src/hints.js";

// primevue-F2: two different root causes, one symptom — a bare browser stack
// with zero remediation text. `hintsForReport` consumes a built report, and a
// mount-phase abort throws before any report exists, so the hint catalog's own
// entry for exactly this case was unreachable.

const PRIMEVUE_SELECT_ABORT =
  "mount phase failed on combo 0 of Select.vue: page.evaluate: TypeError: Cannot read properties " +
  "of undefined (reading 'config')\n    at Proxy.$variant (/e/repositories/primevue/packages/core/" +
  "src/baseinput/BaseInput.vue:31:52)";

const PRIMEVUE_ACCORDION_ABORT =
  "mount phase failed on combo 0 of Accordion.vue: page.evaluate: TypeError: this.$slots.default " +
  "is not a function\n    at Proxy.tabs (/e/repositories/primevue/packages/primevue/src/accordion/" +
  "Accordion.vue:107:39)";

describe("a mount-phase abort names a remedy for the cause its own text shows", () => {
  it("reads a missing Vue plugin global from the component proxy frame", () => {
    expect(hintsForMountAbort(PRIMEVUE_SELECT_ABORT)).toContain("vuePluginGlobals");
  });

  it("reads a called-but-absent slot", () => {
    expect(hintsForMountAbort(PRIMEVUE_ACCORDION_ABORT)).toContain("vueSlotContent");
  });

  it("reads a React provider abort as the render-error class it already had text for", () => {
    const abort =
      "mount phase failed on combo 0 of badge.tsx: page.evaluate: Error: useContext returned " +
      "`undefined`. Seems you forgot to wrap component within <ChakraProvider />";
    expect(hintsForMountAbort(abort)).toContain("mountAbortProvider");
  });

  it("stays silent on a stack that names none of the signatures", () => {
    const abort =
      "mount phase failed on combo 0 of Card.tsx: page.evaluate: TypeError: Cannot read " +
      "properties of null (reading 'length')\n    at Card (/p/Card.tsx:12:3)";
    expect(hintsForMountAbort(abort)).toEqual([]);
  });

  it("names an escape hatch this repository actually has", () => {
    const block = formatHints(hintsForMountAbort(PRIMEVUE_ACCORDION_ABORT));
    expect(block).toContain("--fixture");
    expect(block).toContain(".fixture.vue");
  });

  it("names the wrapper file the Vue entry actually renders inside the app", () => {
    const block = formatHints(hintsForMountAbort(PRIMEVUE_SELECT_ABORT));
    expect(block).toContain("120fps.setup.vue");
    expect(block).toContain("app.use");
  });

  it("produces no block at all when nothing matched", () => {
    expect(formatHints(hintsForMountAbort("mount phase failed: boom"))).toBe("");
  });
});

// C-4: M105's MUST NOT ("Guess") stated as tests. A mount abort routinely
// carries browser-lifecycle text, and the old provider signature (/provider|
// context/i) matched every one of these — then printed renderError's copy,
// which talks about timings and a page-error block a mount abort never has.
describe("a mount abort is never given a provider guess by lifecycle text", () => {
  const lifecycle = [
    "mount phase failed on combo 0 of Button.tsx: page.evaluate: Execution context was destroyed, most likely because of a navigation.",
    "mount phase failed on combo 0 of Button.tsx: Target closed: browser context was closed",
    "mount phase failed on combo 0 of Button.tsx: page.evaluate: Target page, context or browser has been closed",
  ];

  for (const abort of lifecycle) {
    it(`stays silent on: ${abort.slice(abort.indexOf(":") + 1, 60).trim()}...`, () => {
      expect(hintsForMountAbort(abort)).toEqual([]);
      expect(formatHints(hintsForMountAbort(abort))).toBe("");
    });
  }

  it("still fires on an abort that names a context the component reads", () => {
    const abort =
      "mount phase failed on combo 0 of badge.tsx: page.evaluate: Error: useContext returned " +
      "`undefined`. Seems you forgot to wrap component within <ChakraProvider />";
    expect(hintsForMountAbort(abort)).toEqual(["mountAbortProvider"]);
  });

  it("does not claim timings or a page-error block the abort window never had", () => {
    const abort = "mount phase failed on combo 0 of X.vue: page.evaluate: inject('theme') returned undefined";
    const block = formatHints(hintsForMountAbort(abort));
    expect(block).toContain("--wrap");
    expect(block).not.toContain("the timings describe a broken tree");
    expect(block).not.toContain("Read the page errors above");
  });
});
