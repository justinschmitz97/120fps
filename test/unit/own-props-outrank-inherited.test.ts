import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  extractProps,
  extractPropsDetailed,
  detectScalingProps,
  selectMeasuredExport,
  extractPropsDetailed,
  isSynthesizedRequiredObjectWarning,
} from "../../src/prop-gen.js";
// Read-only use of another lane's module: the point is that the two answers agree.
import { detectComponentExport } from "../../src/harness.js";

const FIXTURES = path.resolve(__dirname, "../../fixtures/own-props-rank");
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});
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

// Review B-8: M103 section 3 claimed one function over one export list. There
// are two (`selectMeasuredExport` here, `detectComponentExport` in harness.ts,
// each with its own Provider pattern), and nothing pinned them together. Lane B
// cannot edit harness.ts, so equality is pinned from this side instead.

describe("the export order this file shares with the harness", () => {
  const cases: { exports: { name: string; isDefault: boolean }[]; file: string }[] = [
    { exports: [{ name: "Other", isDefault: false }, { name: "Main", isDefault: true }], file: "badge.tsx" },
    { exports: [{ name: "BadgeAnchor", isDefault: false }, { name: "Badge", isDefault: false }], file: "badge.tsx" },
    { exports: [{ name: "TabsRootProvider", isDefault: false }, { name: "TabsRoot", isDefault: false }], file: "tabs.ts" },
    { exports: [{ name: "TabsRootProvider", isDefault: false }], file: "tabs.ts" },
    { exports: [{ name: "BadgeRoot", isDefault: false }, { name: "BadgeLabel", isDefault: false }, { name: "BadgeAnchor", isDefault: false }], file: "badge.tsx" },
  ];

  it.each(cases)("agrees with detectComponentExport on $file", ({ exports, file }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-exports-"));
    cleanupDirs.push(dir);
    const source = exports
      .map((e) =>
        e.isDefault
          ? `export default function ${e.name}() { return null; }`
          : `export const ${e.name} = () => null;`,
      )
      .join("\n");
    const full = path.join(dir, file);
    fs.writeFileSync(full, source);

    expect(selectMeasuredExport(exports, full)).toBe(detectComponentExport(full).name);
  });

  it("agrees when an explicit target is named", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-exports-"));
    cleanupDirs.push(dir);
    const full = path.join(dir, "badge.tsx");
    fs.writeFileSync(full, "export const BadgeRoot = () => null;\nexport const BadgeLabel = () => null;\n");
    const exports = [
      { name: "BadgeRoot", isDefault: false },
      { name: "BadgeLabel", isDefault: false },
    ];

    expect(selectMeasuredExport(exports, full, "BadgeLabel")).toBe(
      detectComponentExport(full, "BadgeLabel").name,
    );
  });
});

// chakra-F1 (re-test): `colorPalette` is declared in the same 705-member
// generated interface as the three hundred style props, so origin, width and
// shape cannot separate it from them — but its NAME is one a design system
// reserves for its own variant surface.

describe("props whose name is a design system's own variant axis", () => {
  it("keeps colorPalette inside the measured window", async () => {
    const names = (await extractProps(fixture("WideSystemBadge.tsx"))).map((s) => s.name);

    expect(names).toContain("colorPalette");
  });

  it("keeps a literal-union variant declared in the same wide interface", async () => {
    const names = (await extractProps(fixture("WideSystemBadge.tsx"))).map((s) => s.name);

    expect(names).toContain("variant");
  });

  it("ranks them ahead of the style props declared beside them", async () => {
    const names = (await extractProps(fixture("WideSystemBadge.tsx"))).map((s) => s.name);

    expect(names.indexOf("colorPalette")).toBeLessThan(names.indexOf("cssProp0"));
  });

  it("does not promote a name on the list that carries no string-like type", async () => {
    const status = (await extractProps(fixture("NumberBounds.tsx"))).find(
      (s) => s.name === "status",
    );

    expect(status).toBeUndefined();
  });
});

// dub-F2 (disclosure half): `table: TableType<T>` is required, synthesized as a
// placeholder object, and the run then crashes on `table.getVisibleLeafColumns
// is not a function` with nothing said in either mode.

describe("a required prop whose type nothing can be synthesized from", () => {
  it("names the prop, its type and the remedy", async () => {
    const { warnings } = await extractPropsDetailed(fixture("RequiredObjectTable.tsx"), {
      onWarning: () => {},
    });

    const named = warnings.filter(isSynthesizedRequiredObjectWarning);
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('"table"');
    expect(named[0]).toContain("TableInstance");
    expect(named[0]).toContain("RequiredObjectTable.props.tsx");
  });

  it("says nothing about an optional prop of the same shape", async () => {
    const named = (
      await extractPropsDetailed(fixture("RequiredObjectTable.tsx"), { onWarning: () => {} })
    ).warnings.filter(isSynthesizedRequiredObjectWarning);

    expect(named[0]).not.toContain("caption");
  });

  it("says nothing for a component whose required props synthesize cleanly", async () => {
    const { warnings } = await extractPropsDetailed(fixture("DefaultsButton.tsx"), {
      onWarning: () => {},
    });

    expect(warnings.filter(isSynthesizedRequiredObjectWarning)).toEqual([]);
  });
});
