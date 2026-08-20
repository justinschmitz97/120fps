import { describe, it, expect } from "vitest";
import { hintsForReport, formatHints } from "../../src/hints.js";
import type { Report } from "../../src/report.js";

// M79 (4a, base-ui-F2). extraHintLines used to map every providerCandidates
// entry to PROVIDER_HINT_LINE whenever a render error was found, regardless
// of what the captured page-error text actually said. Base UI's own
// render-prop crash text names its own cause; the auto-hint still guessed a
// Context/Provider it never touched. Fix: gate the guess on the captured
// text actually looking provider/context-shaped.

function comboModeReport(pageErrors: string[] | undefined, providerCandidates: string[]): Report {
  return {
    combos: [
      {
        renderHealth: "error",
        ...(pageErrors ? { pageErrors } : {}),
      },
    ],
    providerCandidates,
  } as unknown as Report;
}

describe("M79 4a: provider hint gated on captured error text (combo mode)", () => {
  it("withholds the provider hint when no captured message mentions provider or context", () => {
    const report = comboModeReport(
      ["The `render` prop was provided an invalid React element."],
      ["@radix-ui/react-tabs (useTabsContext)"],
    );
    const ids = hintsForReport(report);
    expect(ids).toContain("renderError");
    const text = formatHints(ids, report);
    // The base renderError hint text always mentions --wrap (a static line);
    // the discriminator under test is the per-candidate "component imports"
    // line, which only PROVIDER_HINT_LINE emits.
    expect(text).not.toContain("component imports");
  });

  it("withholds the provider hint when there are no captured messages at all", () => {
    const report = comboModeReport(undefined, ["@radix-ui/react-tabs (useTabsContext)"]);
    const text = formatHints(hintsForReport(report), report);
    expect(text).not.toContain("component imports");
  });

  it("emits the provider hint when a captured message mentions 'provider'", () => {
    const report = comboModeReport(
      ["useTranslations must be used within a NextIntlClientProvider"],
      ["next-intl (useTranslations)"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports next-intl (useTranslations)");
    expect(text).toContain("--wrap");
  });

  it("emits the provider hint when a captured message mentions 'context' (case-insensitive)", () => {
    const report = comboModeReport(
      ["Cannot read properties of undefined (reading 'Context')"],
      ["src/store.tsx (useWorkbench)"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports src/store.tsx (useWorkbench)");
  });

  it("still prints the base renderError hint text when withheld", () => {
    const report = comboModeReport(["totally unrelated crash"], ["some-lib (useSomething)"]);
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("threw instead of rendering");
  });
});

describe("M79 4a: provider hint gated on captured error text (curve mode)", () => {
  function curveReport(warningText: string, providerCandidates: string[]): Report {
    return {
      combos: [],
      warnings: [warningText],
      providerCandidates,
      scalingCurveReport: { propName: "items", propKind: "array" },
    } as unknown as Report;
  }

  it("emits the provider hint when the curve-mode warning text is provider-shaped", () => {
    const report = curveReport(
      "scale point N=10 rendered 0 DOM nodes while the page threw, so the curve describes a " +
        "broken render: useTabsContext must be used within a Provider",
      ["@radix-ui/react-tabs (useTabsContext)"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports @radix-ui/react-tabs (useTabsContext)");
  });

  it("withholds the provider hint when the curve-mode warning text is unrelated", () => {
    const report = curveReport(
      "scale point N=10 rendered 0 DOM nodes while the page threw, so the curve describes a " +
        "broken render: TypeError: cannot read properties of undefined (reading 'map')",
      ["@radix-ui/react-tabs (useTabsContext)"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).not.toContain("component imports");
  });
});
