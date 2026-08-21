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
    expect(hintsForMountAbort(abort)).toContain("renderError");
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
