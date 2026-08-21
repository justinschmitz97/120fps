import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  extractProps,
  extractPropsDetailed,
  detectScalingProps,
  selectMeasuredExport,
} from "../../src/prop-gen.js";

const FIXTURES = path.resolve(__dirname, "../../fixtures/own-props-rank");
const fixture = (name: string): string => path.join(FIXTURES, name);

// chakra-ui-F1: 32 of 1071 props were measured and none of them were Badge's.
// heroui-F3/F2: `variant`/`placement`/`size` never appeared and the bound
// declaration was a different component in the same file.

describe("the 32-prop cap on a component that inherits a DOM surface", () => {
  it("keeps the component's own props even when they resolve to unknown", async () => {
    const names = (await extractProps(fixture("RecipeBadge.tsx"))).map((s) => s.name);

    expect(names).toEqual(expect.arrayContaining(["colorPalette", "size", "variant", "unstyled"]));
  });

  it("ranks an own prop ahead of an inherited literal-union attribute", async () => {
    const names = (await extractProps(fixture("RecipeBadge.tsx"))).map((s) => s.name);
    const own = names.indexOf("colorPalette");
    const inherited = names.indexOf("translate");

    expect(own).toBeGreaterThanOrEqual(0);
    if (inherited >= 0) expect(own).toBeLessThan(inherited);
  });

  it("ranks an own prop ahead of an inherited event handler", async () => {
    const names = (await extractProps(fixture("RecipeBadge.tsx"))).map((s) => s.name);
    const own = names.indexOf("size");
    const handler = names.indexOf("onCopy");

    expect(own).toBeGreaterThanOrEqual(0);
    if (handler >= 0) expect(own).toBeLessThan(handler);
  });

  it("ranks a variant-shaped own prop ahead of an unknown-typed own prop", async () => {
    const names = (await extractProps(fixture("DefaultsButton.tsx"))).map((s) => s.name);

    expect(names.indexOf("color")).toBeLessThan(names.indexOf("onCopy"));
    expect(names).toEqual(expect.arrayContaining(["color", "variant", "loading", "rounded"]));
  });
});

describe("which export a multi-component file binds", () => {
  it("binds the export the harness measures, not the first one declared", async () => {
    const detail = await extractPropsDetailed(fixture("VariantBadge.tsx"));

    expect(detail.targetName).toBe("BadgeRoot");
  });

  it("reports that export's own requiredness", async () => {
    const detail = await extractPropsDetailed(fixture("VariantBadge.tsx"));
    const children = detail.schemas.find((s) => s.name === "children");

    expect(children?.required).toBe(false);
  });

  it("carries that export's own literal unions with their values", async () => {
    const schemas = await extractProps(fixture("VariantBadge.tsx"));
    const color = schemas.find((s) => s.name === "color");

    expect(color?.kind).toBe("union");
    expect(color?.values).toEqual(
      expect.arrayContaining(["accent", "danger", "default", "success", "warning"]),
    );
    expect(schemas.map((s) => s.name)).toEqual(
      expect.arrayContaining(["placement", "size", "variant"]),
    );
  });

  it("still honours an explicit target over the measured-export order", async () => {
    const detail = await extractPropsDetailed(fixture("VariantBadge.tsx"), {
      target: "BadgeAnchor",
    });

    expect(detail.targetName).toBe("BadgeAnchor");
    expect(detail.schemas.find((s) => s.name === "children")?.required).toBe(true);
  });
});

describe("the export selection order shared with the harness", () => {
  it("prefers the default export", () => {
    const chosen = selectMeasuredExport(
      [
        { name: "Other", isDefault: false },
        { name: "Main", isDefault: true },
      ],
      "badge.tsx",
    );

    expect(chosen).toBe("Main");
  });

  it("prefers an export named after the file stem", () => {
    const chosen = selectMeasuredExport(
      [
        { name: "BadgeAnchor", isDefault: false },
        { name: "Badge", isDefault: false },
      ],
      "badge.tsx",
    );

    expect(chosen).toBe("Badge");
  });

  it("skips a Provider export while another component export exists", () => {
    const chosen = selectMeasuredExport(
      [
        { name: "TabsRootProvider", isDefault: false },
        { name: "TabsRoot", isDefault: false },
      ],
      "tabs.ts",
    );

    expect(chosen).toBe("TabsRoot");
  });

  it("takes a Provider export when it is the only one", () => {
    const chosen = selectMeasuredExport([{ name: "TabsRootProvider", isDefault: false }], "tabs.ts");

    expect(chosen).toBe("TabsRootProvider");
  });

  it("answers nothing for an empty export list", () => {
    expect(selectMeasuredExport([], "tabs.ts")).toBeUndefined();
  });
});

// base-ui-F3: curve mode auto-activated on NumberFieldRoot's `max`, then the run
// reported that the DOM node count never moved across the scale points.

describe("curve mode on numeric props", () => {
  it("does not activate on a name that denotes a bound or a step", async () => {
    const schemas = await extractProps(fixture("NumberBounds.tsx"));

    expect(detectScalingProps(schemas)).toEqual([]);
  });

  it("still activates on a numeric prop that counts rendered things", async () => {
    const schemas = await extractProps(fixture("ItemCount.tsx"));
    const matches = detectScalingProps(schemas);

    expect(matches.map((m) => m.schema.name)).toEqual(["rowCount"]);
  });
});
