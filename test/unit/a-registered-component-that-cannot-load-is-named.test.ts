import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  COMPONENT_LOAD_FAILURES_WARNING,
  componentLoadFailures,
} from "../../src/pipeline/index.js";
import { COMPONENT_LOAD_FAILURE_PREFIX } from "../../src/harness/index.js";
import {
  autoImportMapEvidence,
  generatedDeclarationMapFiles,
} from "../../src/project/index.js";
import type { Report } from "../../src/report/index.js";

const failureLine = (name: string, detail: string) =>
  `${COMPONENT_LOAD_FAILURE_PREFIX} ${name} failed to load: ${detail}`;

const report = (over: Partial<Report>): Report =>
  ({ combos: [], warnings: [], ...over }) as unknown as Report;

describe("a registration the browser could not fetch", () => {
  it("is read back off the combo's page errors", () => {
    const found = componentLoadFailures(
      report({
        combos: [
          { pageErrors: [failureLine("UCarousel", 'Missing "#imports" specifier')] },
        ] as unknown as Report["combos"],
      }),
    );
    expect(found).toEqual([{ name: "UCarousel", detail: 'Missing "#imports" specifier' }]);
  });

  it("is read back off a curve point too, and named once across both", () => {
    const found = componentLoadFailures(
      report({
        combos: [{ pageErrors: [failureLine("UCarousel", "boom")] }] as unknown as Report["combos"],
        scalingCurveReport: {
          points: [{ pageErrors: [`${failureLine("UCarousel", "boom")} (×4)`] }],
        } as unknown as Report["scalingCurveReport"],
      }),
    );
    expect(found).toEqual([{ name: "UCarousel", detail: "boom" }]);
  });

  it("reads nothing out of an ordinary page error", () => {
    expect(
      componentLoadFailures(
        report({
          combos: [
            { pageErrors: ["TypeError: Cannot read properties of undefined"] },
          ] as unknown as Report["combos"],
        }),
      ),
    ).toEqual([]);
  });

  it("names every failure and says the numbers describe a tree without them", () => {
    const text = COMPONENT_LOAD_FAILURES_WARNING([
      { name: "UCarousel", detail: "500" },
      { name: "UButton", detail: "404" },
    ]);
    expect(text).toContain("UCarousel (500)");
    expect(text).toContain("UButton (404)");
    expect(text).toContain("rendered nothing");
    expect(text).toContain("a tree without them");
  });
});

const VUE_MAPS = path.resolve("fixtures/vue-auto-imports-map");
const NO_MAPS = path.resolve("fixtures/vue-no-generated-map");

describe("the run only claims a map it would have read", () => {
  it("offers no map evidence for a React component", () => {
    expect(autoImportMapEvidence(VUE_MAPS, path.join(VUE_MAPS, "Card.tsx"))).toBeUndefined();
  });

  it("offers no map evidence when transforms are switched off", () => {
    const componentPath = path.join(VUE_MAPS, "src", "components", "UsesCounter.vue");
    expect(autoImportMapEvidence(VUE_MAPS, componentPath, true)).toBeUndefined();
    expect(autoImportMapEvidence(VUE_MAPS, componentPath, false)).toBeDefined();
  });

  it("offers no map evidence for a project that has none", () => {
    expect(
      autoImportMapEvidence(NO_MAPS, path.join(NO_MAPS, "Plain.vue")),
    ).toBeUndefined();
  });
});

describe("the maps belong to the identity of a cached verdict", () => {
  it("lists the map files a Vue component's run resolves through", () => {
    const files = generatedDeclarationMapFiles(
      VUE_MAPS,
      path.join(VUE_MAPS, "src", "components", "UsesCounter.vue"),
    ).map((file) => path.basename(file));
    expect(files).toContain("auto-imports.d.ts");
  });

  it("lists none for a React component", () => {
    expect(generatedDeclarationMapFiles(VUE_MAPS, path.join(VUE_MAPS, "Card.tsx"))).toEqual([]);
  });

  it("lists none for a project without a map", () => {
    expect(generatedDeclarationMapFiles(NO_MAPS, path.join(NO_MAPS, "Plain.vue"))).toEqual([]);
  });
});
