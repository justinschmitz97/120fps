import { describe, it, expect } from "vitest";
import { detectProviderImport, providerCandidateLabels } from "../../src/project/index.js";
import { hintsForReport, formatHints, PROVIDER_SUSPECT_LINE } from "../../src/report/index.js";
import type { Report } from "../../src/report/index.js";

function renderFailure(pageErrors: string[], providerCandidates: string[]): Report {
  return {
    combos: [{ renderHealth: "error", pageErrors }],
    providerCandidates,
  } as unknown as Report;
}

describe("the packages a component-kit import makes a provider suspect", () => {
  it("covers the scoped kits the corpus mounts", () => {
    expect(detectProviderImport("@mantine/core")).toEqual({ source: "@mantine/core" });
    expect(detectProviderImport("@chakra-ui/react")).toEqual({ source: "@chakra-ui/react" });
    expect(detectProviderImport("@radix-ui/react-dialog")).toEqual({
      source: "@radix-ui/react-dialog",
    });
  });

  it("covers the context libraries the deep run found", () => {
    expect(detectProviderImport("react-intl")?.hook).toBe("useIntl");
    expect(detectProviderImport("jotai")?.hook).toBe("useAtom");
    expect(detectProviderImport("jotai-scope")?.hook).toBe("useAtom");
    expect(detectProviderImport("@trpc/tanstack-react-query")?.hook).toBe("useTRPC");
    expect(detectProviderImport("@trpc/react-query")?.hook).toBe("useQuery");
    expect(detectProviderImport("@trpc/client")).toEqual({ source: "@trpc/client" });
  });

  it("still suspects nothing for a package that provides nothing", () => {
    expect(detectProviderImport("clsx")).toBeUndefined();
    expect(detectProviderImport("@headlessui/react")).toBeUndefined();
    expect(providerCandidateLabels([])).toEqual([]);
  });
});

describe("the remedy a render failure with a provider suspect prints", () => {
  it("names the suspect, the page-error phrase and the recipe", () => {
    const report = renderFailure(
      ["@mantine/core: MantineProvider was not found in component tree, make sure you have it in your app"],
      ["@mantine/core"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports @mantine/core");
    expect(text).toContain("MantineProvider was not found");
    expect(text).toContain("120fps.setup.tsx");
    expect(text).toContain("120fps.setup.vue");
  });

  it("ranks the suspect the error text names first", () => {
    const report = renderFailure(
      ["Error: useChakra: `context` is undefined. Seems you forgot to wrap in <ChakraProvider />"],
      ["react-redux (useSelector)", "@chakra-ui/react"],
    );
    const text = formatHints(hintsForReport(report), report);
    const chakra = text.indexOf("@chakra-ui/react");
    const redux = text.indexOf("react-redux");
    expect(chakra).toBeGreaterThan(-1);
    expect(chakra).toBeLessThan(redux);
  });

  it("presents exactly one candidate as the suspect", () => {
    const report = renderFailure(
      ["Error: useChakra: `context` is undefined. Seems you forgot to wrap in <ChakraProvider />"],
      ["react-redux (useSelector)", "@chakra-ui/react"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text.split("the page error says").length - 1).toBe(1);
  });

  it("ranks a candidate the error names through a doubled suffix", () => {
    const report = renderFailure(
      ["Please wrap your application in an OperatingSystemContextProvider."],
      ["@radix-ui/react-switch", "app/primitives/OperatingSystemProvider.tsx (useOperatingSystem)"],
    );
    const text = formatHints(hintsForReport(report), report);
    const local = text.indexOf("OperatingSystemProvider.tsx");
    const radix = text.indexOf("@radix-ui/react-switch");
    expect(local).toBeGreaterThan(-1);
    expect(local).toBeLessThan(radix);
  });

  it("quotes the phrase whose symbol ranked the leader, not the first error", () => {
    const report = renderFailure(
      [
        "Error: something about a context that came first",
        "Please wrap your application in an OperatingSystemContextProvider.",
      ],
      ["@radix-ui/react-switch", "app/primitives/OperatingSystemProvider.tsx (useOperatingSystem)"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain('the page error says "Please wrap your application in an OperatingSystemContextProvider."');
    expect(text).not.toContain("something about a context that came first");
  });

  it("never instructs without the phrase that supports the instruction", () => {
    // The imperative and its evidence are one string, so neither can print without the other.
    expect(PROVIDER_SUSPECT_LINE("@mantine/core", false, "MantineProvider was not found")).toContain(
      'the page error says "MantineProvider was not found"',
    );
    for (const errors of [
      ["Error: cannot read properties of null"],
      ["Error: useChakra: `context` is undefined"],
      [],
    ]) {
      const report = renderFailure(errors, ["@mantine/core"]);
      const text = formatHints(hintsForReport(report), report);
      if (text.includes("render it inside that provider")) {
        expect(text).toContain('the page error says "');
      }
    }
  });

  it("hedges for every candidate below the leader", () => {
    const report = renderFailure(
      ["Error: useChakra: `context` is undefined. Seems you forgot to wrap in <ChakraProvider />"],
      ["react-redux (useSelector)", "@chakra-ui/react"],
    );
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("component imports react-redux (useSelector): likely needs a provider wrapper");
  });

  it("keeps the generic remedy when the run found no candidate", () => {
    const report = renderFailure(["TypeError: cannot read properties of null"], []);
    const text = formatHints(hintsForReport(report), report);
    expect(text).toContain("the component threw instead of rendering");
    expect(text).not.toContain("component imports");
    expect(text).not.toContain("the page error says");
  });
});
