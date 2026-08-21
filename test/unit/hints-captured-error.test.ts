import { describe, it, expect } from "vitest";
import { hintsForReport, formatHints, PROVIDER_HINT_LINE, PROVIDER_HINT_LINE_TRANSITIVE } from "../../src/hints.js";
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

// M92 (dub button.tsx): a captured error naming a specific symbol
// ("`Tooltip` must be used within `TooltipProvider`") should have a matching
// candidate lead the guess when more than one real candidate exists, instead
// of an unrelated one winning purely by discovery order.
describe("M92: a named symbol in the error ranks its matching candidate first", () => {
  it("moves the matching candidate to the front", () => {
    const report = comboModeReport(
      ["`Tooltip` must be used within `TooltipProvider`"],
      ["src/rich-text-area/rich-text-provider.tsx (useRichTextContext)", "src/tooltip.tsx (useTooltip)"],
    );
    const text = formatHints(hintsForReport(report), report);
    const tooltipIdx = text.indexOf("component imports src/tooltip.tsx");
    const richTextIdx = text.indexOf("component imports src/rich-text-area/rich-text-provider.tsx");
    expect(tooltipIdx).toBeGreaterThan(-1);
    expect(richTextIdx).toBeGreaterThan(-1);
    expect(tooltipIdx).toBeLessThan(richTextIdx);
  });

  it("still prints every candidate, only reordered", () => {
    const report = comboModeReport(
      ["`Tooltip` must be used within `TooltipProvider`"],
      ["src/rich-text-area/rich-text-provider.tsx (useRichTextContext)", "src/tooltip.tsx (useTooltip)"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports src/tooltip.tsx (useTooltip)");
    expect(text).toContain("component imports src/rich-text-area/rich-text-provider.tsx");
  });

  it("leaves order unchanged when no candidate matches the named symbol", () => {
    const report = comboModeReport(
      ["`Tooltip` must be used within `TooltipProvider`"],
      ["next-intl (useTranslations)", "src/store.tsx (useWorkbench)"],
    );
    const text = formatHints(hintsForReport(report), report);
    const firstIdx = text.indexOf("component imports next-intl");
    const secondIdx = text.indexOf("component imports src/store.tsx");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("leaves order unchanged when the error names no Provider/Context symbol", () => {
    const report = comboModeReport(
      ["useTooltip must be used within its provider"],
      ["next-intl (useTranslations)", "src/tooltip.tsx (useTooltip)"],
    );
    const text = formatHints(hintsForReport(report), report);
    const firstIdx = text.indexOf("component imports next-intl");
    const secondIdx = text.indexOf("component imports src/tooltip.tsx");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
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

// M92 gap 3 (dub tooltip.tsx -> rich-text-provider.tsx, verified against
// real source): a candidate reached only transitively (an intermediate file
// the component imports is what actually imports it, not the component
// itself) must not be worded "component imports X" -- that overclaims a
// direct relationship the run never observed.
describe("M92 gap 3: transitive-reach candidates get honest wording", () => {
  function reportWith(providerCandidates: string[], transitiveProviderCandidates: string[]): Report {
    return {
      combos: [{ renderHealth: "error", pageErrors: ["useDeepContext must be used within DeepProvider"] }],
      providerCandidates,
      transitiveProviderCandidates,
    } as unknown as Report;
  }

  it("a direct candidate keeps 'component imports'", () => {
    const report = reportWith(["tooltip.tsx (TooltipProvider)"], []);
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports tooltip.tsx (TooltipProvider)");
    expect(text).not.toContain("import graph reaches");
  });

  it("a transitive candidate gets 'component's import graph reaches' instead", () => {
    const report = reportWith(
      ["deep-provider.tsx (useDeepContext)"],
      ["deep-provider.tsx (useDeepContext)"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component's import graph reaches deep-provider.tsx (useDeepContext)");
    expect(text).not.toContain("component imports deep-provider.tsx");
  });

  it("a mix of direct and transitive candidates gets per-candidate wording, not a blanket choice", () => {
    const report = reportWith(
      ["tooltip.tsx (TooltipProvider)", "rich-text-provider.tsx (useRichTextContext)"],
      ["rich-text-provider.tsx (useRichTextContext)"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports tooltip.tsx (TooltipProvider)");
    expect(text).toContain("component's import graph reaches rich-text-provider.tsx (useRichTextContext)");
    expect(text).not.toContain("component imports rich-text-provider.tsx");
  });

  it("no report.transitiveProviderCandidates field at all behaves exactly as before (regression safety)", () => {
    const report = {
      combos: [{ renderHealth: "error", pageErrors: ["useDeepContext must be used within DeepProvider"] }],
      providerCandidates: ["deep-provider.tsx (useDeepContext)"],
    } as unknown as Report;
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports deep-provider.tsx (useDeepContext)");
  });

  it("PROVIDER_HINT_LINE and PROVIDER_HINT_LINE_TRANSITIVE differ only in the leading verb, same remedy", () => {
    const direct = PROVIDER_HINT_LINE("x.tsx (X)");
    const transitive = PROVIDER_HINT_LINE_TRANSITIVE("x.tsx (X)");
    expect(direct).toContain("component imports x.tsx (X)");
    expect(transitive).toContain("component's import graph reaches x.tsx (X)");
    expect(direct.split(": ")[1]).toBe(transitive.split(": ")[1]);
  });
});
