import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { measureMount } from "../../src/measure.js";

// H33: component that renders null
describe("H33: renders-null component", () => {
  it("measures component that returns null", async () => {
    const harness = await buildAndServe("./fixtures/renders-null.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{ visible: false }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.samples).toHaveLength(2);
      expect(results[0].mount.median).toBeGreaterThanOrEqual(0);
      // DOM count should be very low (just root div)
      expect(results[0].domNodeCount).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });
});

// H34: component with async useEffect
describe("H34: useEffect settle time", () => {
  it("measures useEffect component without errors", async () => {
    const harness = await buildAndServe("./fixtures/use-effect.tsx");
    try {
      const results = await measureMount(harness, { samples: 2 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].mount.median).toBeGreaterThanOrEqual(0);
    } finally {
      await harness.cleanup();
    }
  });
});

// H36: ReactNode prop serialized as placeholder string
describe("H36: ReactNode prop serialization", () => {
  it("measures button with children prop (ReactNode)", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{ label: "Test", children: "120fps-placeholder" }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.samples).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });
});

// H37: rapid mount/unmount cycle
describe("H37: rapid mount/unmount", () => {
  it("handles rapid cycles without errors", async () => {
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 3,
        combos: [{}],
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.samples).toHaveLength(3);
      expect(results[0].unmount.samples).toHaveLength(3);
    } finally {
      await harness.cleanup();
    }
  });
});

// H38: component that throws on mount
describe("H38: throwing component", () => {
  it("measureMount with crash-prone props still returns result", async () => {
    const harness = await buildAndServe("./fixtures/throws-on-render.tsx");
    try {
      // Mount with valid props — should work fine
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{ data: { id: "1", name: "Test" } }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.median).toBeGreaterThanOrEqual(0);
    } finally {
      await harness.cleanup();
    }
  });
});

// H39: large DOM component
describe("H39: large DOM count", () => {
  it("accurately counts 500+ DOM nodes", async () => {
    const harness = await buildAndServe("./fixtures/large-dom.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{ count: 500 }],
      });
      expect(results).toHaveLength(1);
      // 500 items * 2 elements each (div + span) + container div + root = ~1002
      expect(results[0].domNodeCount).toBeGreaterThan(500);
    } finally {
      await harness.cleanup();
    }
  });
});

// H40: sequential measureMount calls on same harness
describe("H40: sequential measures", () => {
  it("two measureMount calls on same harness produce independent results", async () => {
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      const r1 = await measureMount(harness, { samples: 2, combos: [{}] });
      const r2 = await measureMount(harness, { samples: 2, combos: [{}] });
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      // Both should have valid timing data
      expect(r1[0].mount.median).toBeGreaterThanOrEqual(0);
      expect(r2[0].mount.median).toBeGreaterThanOrEqual(0);
    } finally {
      await harness.cleanup();
    }
  });
});

// H43: index signature prop (object)
describe("H43: index-sig component", () => {
  it("measures component with Record/index-sig prop", async () => {
    const harness = await buildAndServe("./fixtures/index-sig.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{ data: { key: "val" }, label: "test" }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.samples).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });
});
