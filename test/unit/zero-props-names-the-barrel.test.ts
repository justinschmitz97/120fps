import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  explainProps,
  explainsZeroPropCount,
  formatExplainProps,
  RE_EXPORT_MEASURED_DISCLOSURE,
  UNRESOLVED_RE_EXPORT_WARNING,
  ZERO_PROPS_WARNING,
} from "../../src/analyze.js";
import { extractPropsDetailed } from "../../src/prop-gen.js";

// gutenberg-F2 and react-spectrum-F3: a barrel printed `Props (0):` and then
// the generic "extraction may have failed" sentence, whose floated malfunction
// was false for a cause the filesystem decides.
const DIR = path.resolve("fixtures/barrel-reexport");
const fixture = (name: string): string => path.join(DIR, name);
const REPO_ROOT = process.cwd();
const relative = (name: string): string =>
  path.relative(REPO_ROOT, fixture(name)).split(path.sep).join("/");

describe("a component reached through a re-export", () => {
  it("names the module its props were read from", async () => {
    const explained = await explainProps(fixture("index.tsx"), {});

    expect(explained.reExport).toEqual({
      barrel: relative("index.tsx"),
      module: relative("component.tsx"),
    });
  });

  it("points the binding line at the declaring module, not at the barrel", async () => {
    const explained = await explainProps(fixture("index.tsx"), {});

    expect(explained.bindingFile).toBe(relative("component.tsx"));
    expect(explained.bindingLine).toBe(8);
    expect(formatExplainProps(explained)).toContain(`binding:  ${relative("component.tsx")}:8`);
  });

  it("prints the disclosure beside the binding line", async () => {
    const explained = await explainProps(fixture("index.tsx"), {});

    expect(formatExplainProps(explained)).toContain(
      RE_EXPORT_MEASURED_DISCLOSURE(relative("index.tsx"), relative("component.tsx")),
    );
  });

  it("prints the declaring module's props, not an empty table", async () => {
    const explained = await explainProps(fixture("index.tsx"), {});

    expect(explained.props.map((p) => p.name).sort()).toEqual([
      "cancelLabel",
      "confirmLabel",
      "isOpen",
      "title",
    ]);
    expect(explained.warnings).not.toContain(ZERO_PROPS_WARNING);
  });

  // M114 review: the real run builds the same two disclosures from
  // extractPropsDetailed's record, so the record the run reads carries the
  // declaring module and produces byte-identical text.
  it("gives the measured run the same declaring module the dry run printed", async () => {
    const extracted = await extractPropsDetailed(fixture("index.tsx"), {});
    const explained = await explainProps(fixture("index.tsx"), {});

    expect(extracted.targetFile).toBeDefined();
    expect(path.relative(REPO_ROOT, extracted.targetFile!).split(path.sep).join("/")).toBe(
      relative("component.tsx"),
    );
    expect(
      RE_EXPORT_MEASURED_DISCLOSURE(relative("index.tsx"), relative("component.tsx")),
    ).toBe(RE_EXPORT_MEASURED_DISCLOSURE(explained.reExport!.barrel, explained.reExport!.module));
  });

  it("says nothing about a re-export for a component declared in the measured file", async () => {
    const explained = await explainProps(fixture("component.tsx"), {});

    expect(explained.reExport).toBeUndefined();
    expect(formatExplainProps(explained)).not.toContain("re-export of");
  });
});

describe("a re-export whose specifier does not resolve", () => {
  it("names the barrel and the specifier in place of the generic zero-props warning", async () => {
    const explained = await explainProps(fixture("broken.tsx"), {});

    expect(explained.warnings).toContain(
      UNRESOLVED_RE_EXPORT_WARNING(relative("broken.tsx"), "@adobe/react-spectrum/ConfirmDialog"),
    );
    expect(explained.warnings).not.toContain(ZERO_PROPS_WARNING);
  });

  it("reads as a cause the filesystem decided, not a failed extraction", () => {
    const text = UNRESOLVED_RE_EXPORT_WARNING("src/index.ts", "@adobe/react-spectrum/Button");

    expect(text).toBe(
      "src/index.ts re-exports @adobe/react-spectrum/Button, which did not resolve: no props " +
        "were read there",
    );
  });

  it("explains the zero count, so ZERO_PROPS_WARNING never stacks on top of it", () => {
    expect(
      explainsZeroPropCount(UNRESOLVED_RE_EXPORT_WARNING("src/index.ts", "@adobe/x/Button")),
    ).toBe(true);
    expect(explainsZeroPropCount(ZERO_PROPS_WARNING)).toBe(false);
  });
});
