import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { measureMount } from "../../src/measure.js";

// H53: heavy computation during mount — timing should be non-trivial
describe("H53: heavy computation mount", () => {
  it("measures component with expensive render", async () => {
    const harness = await buildAndServe("./fixtures/heavy-mount.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{ iterations: 10000 }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.median).toBeGreaterThanOrEqual(0);
      expect(results[0].mount.samples).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });
});

// H54: deeply nested object props — serialization handles depth
describe("H54: deeply nested object props", () => {
  it("serializes and passes nested config object", async () => {
    const harness = await buildAndServe("./fixtures/deep-props.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{
          config: {
            theme: {
              colors: { primary: "red", secondary: "blue" },
              spacing: 8,
            },
          },
          label: "test",
        }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.samples).toHaveLength(2);
      expect(results[0].domNodeCount).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });
});

// H55: multiple function props — all get serialized correctly
describe("H55: multiple function props", () => {
  it("serializes all function props and component renders", async () => {
    const harness = await buildAndServe("./fixtures/many-callbacks.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{
          onClick: () => {},
          onChange: () => {},
          onSubmit: () => {},
          onBlur: () => {},
          label: "Submit",
        }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.samples).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });
});

// H56: empty props object (no keys at all)
describe("H56: empty props object", () => {
  it("handles completely empty props", async () => {
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{}],
      });
      expect(results).toHaveLength(1);
      expect(results[0].props).toEqual({});
    } finally {
      await harness.cleanup();
    }
  });
});

// H57: single combo with many samples
describe("H57: high sample count", () => {
  it("works with 5 samples per combo", async () => {
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 5,
        combos: [{}],
      });
      expect(results[0].mount.samples).toHaveLength(5);
      expect(results[0].unmount.samples).toHaveLength(5);
      expect(results[0].mount.p95).toBeGreaterThanOrEqual(results[0].mount.median);
    } finally {
      await harness.cleanup();
    }
  });
});

// H58: auto-extract combos (no combos override)
describe("H58: auto-extract combos from component path", () => {
  it("auto-extracts and measures no-props component", async () => {
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      // No combos option — should auto-extract (Divider has no props → [{}])
      const results = await measureMount(harness, { samples: 2 });
      expect(results).toHaveLength(1);
      expect(results[0].props).toEqual({});
    } finally {
      await harness.cleanup();
    }
  });
  it("auto-extracts combos for button component", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    try {
      const results = await measureMount(harness, { samples: 2 });
      // Button has label(string), variant(3 values), disabled(bool), onClick(fn), children(reactnode)
      // Should produce multiple combos
      expect(results.length).toBeGreaterThan(1);
    } finally {
      await harness.cleanup();
    }
  });
});
