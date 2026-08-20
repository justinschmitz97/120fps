import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  splitTargetSpec,
  formatWallClock,
  helpText,
} from "../../src/cli.js";
import {
  explainProps,
  formatExplainProps,
  resolveProgressReporter,
} from "../../src/analyze.js";
import {
  runPreflight,
  detectProviderImport,
  providerCandidateLabels,
  HARD_REMEDY,
} from "../../src/preflight.js";
import { detectComponentExport, BUNDLER_PREACT_ALIAS_WARNING } from "../../src/harness.js";
import { extractPropsDetailed } from "../../src/prop-gen.js";
import { formatHints } from "../../src/hints.js";
import type { Report } from "../../src/report.js";

const fixture = (rel: string): string => path.resolve("fixtures", rel);

function lineOf(file: string, needle: string): number {
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  const index = lines.findIndex((l) => l.includes(needle));
  return index + 1;
}

// --- C5: `<file>#Export` splitting, decided without the filesystem ---

describe("target spec splitting", () => {
  it("splits a component path from its export name", () => {
    expect(splitTargetSpec("./fixtures/two-exports.tsx#SecondaryBtn")).toEqual({
      path: "./fixtures/two-exports.tsx",
      target: "SecondaryBtn",
    });
  });

  it("leaves a Windows path with a # directory segment whole", () => {
    const p = "C:\\Projekte\\c#1\\Button.tsx";
    expect(splitTargetSpec(p)).toEqual({ path: p });
  });

  it("leaves a Windows path whose filename contains # whole", () => {
    const p = "C:\\Projekte\\120fps\\Button#2.tsx";
    expect(splitTargetSpec(p)).toEqual({ path: p });
  });

  it("splits a Windows absolute path from its export name", () => {
    expect(splitTargetSpec("C:\\Projekte\\120fps\\fixtures\\two-exports.tsx#SecondaryBtn")).toEqual({
      path: "C:\\Projekte\\120fps\\fixtures\\two-exports.tsx",
      target: "SecondaryBtn",
    });
  });

  it("does not split when the left side is not a component file", () => {
    expect(splitTargetSpec("./notes.md#Heading")).toEqual({ path: "./notes.md#Heading" });
  });

  it("does not split on a non-identifier fragment", () => {
    expect(splitTargetSpec("./a.tsx#not-an-identifier")).toEqual({
      path: "./a.tsx#not-an-identifier",
    });
  });

  it("parseArgs records the target keyed by the path it typed", () => {
    const args = parseArgs(["./fixtures/two-exports.tsx#SecondaryBtn"]);
    expect(args.error).toBeUndefined();
    expect(args.componentPath).toBe("./fixtures/two-exports.tsx");
    expect(args.targets).toEqual({ "./fixtures/two-exports.tsx": "SecondaryBtn" });
  });

  it("parseArgs rejects --fixture combined with an export target", () => {
    const args = parseArgs([
      "./fixtures/two-exports.tsx#SecondaryBtn",
      "--fixture",
      "./fixtures/standalone.fixture.tsx",
    ]);
    expect(args.error).toMatch(/#/);
  });
});

describe("explicit export resolution", () => {
  it("resolves the named export over the default selection order", () => {
    expect(detectComponentExport(fixture("two-exports.tsx")).name).toBe("PrimaryBtn");
    expect(detectComponentExport(fixture("two-exports.tsx"), "SecondaryBtn")).toEqual({
      name: "SecondaryBtn",
      isDefaultOnly: false,
    });
  });

  it("throws a message listing the file's component exports", () => {
    expect(() => detectComponentExport(fixture("two-exports.tsx"), "Nope")).toThrow(
      /Nope/,
    );
    let message = "";
    try {
      detectComponentExport(fixture("two-exports.tsx"), "Nope");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("PrimaryBtn");
    expect(message).toContain("SecondaryBtn");
  });

  it("binds prop extraction to the named export", async () => {
    const detail = await extractPropsDetailed(fixture("two-exports.tsx"), {
      target: "SecondaryBtn",
    });
    expect(detail.targetName).toBe("SecondaryBtn");
    expect(detail.schemas.map((s) => s.name).sort()).toEqual(["outlined", "text"]);
  });
});

// --- C6: one stem rule ---

describe("the harness resolver uses the normalized stem", () => {
  it("resolves hotspot-image.tsx to HotspotImage", () => {
    expect(detectComponentExport(fixture("m58/hotspot-image.tsx")).name).toBe("HotspotImage");
  });

  it("resolves alias-widget.tsx to the exported alias", () => {
    expect(detectComponentExport(fixture("m58/alias-widget.tsx")).name).toBe("AliasWidget");
  });
});

// --- C1: --explain-props ---

describe("--explain-props", () => {
  it("is a known flag and appears in --help", () => {
    const args = parseArgs(["./fixtures/button.tsx", "--explain-props"]);
    expect(args.error).toBeUndefined();
    expect(args.explainProps).toBe(true);
    expect(helpText()).toContain("--explain-props");
    expect(helpText()).toContain("#ExportName");
  });

  it("names the resolved component and the declaration it bound to", async () => {
    const file = fixture("m58/hotspot-image.tsx");
    const explained = await explainProps(file);
    expect(explained.componentName).toBe("HotspotImage");
    expect(explained.bindingLine).toBe(lineOf(file, "export function HotspotImage"));
    expect(explained.bindingFile).toMatch(/hotspot-image\.tsx$/);
    expect(explained.exports).toEqual(["Marker", "HotspotImage"]);
    expect(explained.props.map((p) => p.name).sort()).toEqual(["hotspots", "src", "zoom"]);
  });

  it("reports the prop that would drive curve mode", async () => {
    const explained = await explainProps(fixture("m58/hotspot-image.tsx"));
    expect(explained.curve?.propName).toBe("hotspots");
    const text = formatExplainProps(explained);
    expect(text).toContain("Curve mode:");
    expect(text).toContain("hotspots");
  });

  it("enumerates cva unions and reports matrix auto-activation", async () => {
    const explained = await explainProps(fixture("m60/cva-button.tsx"));
    const variant = explained.props.find((p) => p.name === "variant");
    expect(variant?.kind).toBe("union");
    expect(variant?.values).toEqual(
      expect.arrayContaining(["default", "destructive", "outline"]),
    );
    expect(explained.matrixWouldActivate).toBe(true);
    expect(formatExplainProps(explained)).toContain("Matrix mode:");
  });

  it("marks degenerate props with a reason", async () => {
    const explained = await explainProps(fixture("m60/unsynthesizable.tsx"));
    const store = explained.props.find((p) => p.name === "store");
    expect(store?.degenerate).toBeTruthy();
    const text = formatExplainProps(explained);
    expect(text).toContain("degenerate");
    expect(explained.warnings.join("\n")).toMatch(/no representative value/i);
  });

  it("explains a named export target", async () => {
    const explained = await explainProps(fixture("two-exports.tsx"), {
      target: "SecondaryBtn",
    });
    expect(explained.componentName).toBe("SecondaryBtn");
    expect(explained.props.map((p) => p.name).sort()).toEqual(["outlined", "text"]);
  });

  it("explains a Vue SFC", async () => {
    const explained = await explainProps(fixture("vue-project/Button.vue"));
    expect(explained.componentName).toBe("Button");
    expect(explained.props.map((p) => p.name).sort()).toEqual([
      "count",
      "disabled",
      "label",
      "variant",
    ]);
    expect(formatExplainProps(explained)).toContain("Button");
  });
});

// M78: --explain-props ran no preflight gate at all, exiting 0 on a Solid or
// PnP project the default path rejects in ~1s (solid-ui-F1, pnp-app-F2). The
// comment at this call's cli.ts site has always promised "before every check
// that exists to protect a measurement" — these tests are that promise, kept.
describe("--explain-props gate parity", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function isolatedProject(prefix: string, files: Record<string, string>): { root: string; entry: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    return { root, entry: path.join(root, "Card.tsx") };
  }

  it("rejects a Solid project the same way the default path does", async () => {
    const { entry } = isolatedProject("120fps-explain-solid-", {
      "package.json": JSON.stringify({ dependencies: { "solid-js": "^1.8.0" } }),
      "Card.tsx": "export function Card() { return null; }\n",
    });
    await expect(explainProps(entry)).rejects.toThrow(/Solid/);
  });

  // async-component is a hard preflight kind with nothing to do with
  // react-dom resolution, so a bypass here reaches extraction successfully:
  // unlike the Solid/PnP cases below, assertReactDomClient's independent
  // taxonomy does not also reject this project.
  it("downgrades to a warning and still extracts under --no-preflight (noPreflight: true)", async () => {
    const { root, entry } = isolatedProject("120fps-explain-async-bypass-", {
      "package.json": JSON.stringify({ dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" } }),
      "Card.tsx": "export async function Card() { return null; }\n",
    });
    const pkgDir = path.join(root, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "react-dom", version: "18.2.0", main: "index.js" }));
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};\n");

    const explained = await explainProps(entry, { noPreflight: true });
    expect(explained.warnings.some((w) => w.includes("--no-preflight"))).toBe(true);
  });

  // solid-ui-F3 / pnp-app-F3: --no-preflight downgrades the graph-walk hard
  // hit to a warning, but assertReactDomClient is a separate, unconditional
  // gate — for a Solid-only project it independently reaches the same
  // conclusion runPreflight already did, so the final error still names
  // Solid, never a fabricated react-dom-version claim.
  it("still fails under --no-preflight for a Solid project, naming Solid, not a fabricated react-dom version", async () => {
    const { entry } = isolatedProject("120fps-explain-solid-bypass-backstop-", {
      "package.json": JSON.stringify({ dependencies: { "solid-js": "^1.8.0" } }),
      "Card.tsx": "export function Card() { return null; }\n",
    });
    let thrown: unknown;
    try {
      await explainProps(entry, { noPreflight: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain("React 18+ required");
    expect(message).toContain("solid-js");
    expect(message).toContain(HARD_REMEDY["unsupported-framework"]);
  });

  it("rejects a Yarn PnP project the same way the default path does", async () => {
    const { root, entry } = isolatedProject("120fps-explain-pnp-", {
      "package.json": "{}",
      "Card.tsx": "export function Card() { return null; }\n",
    });
    fs.writeFileSync(path.join(root, ".pnp.cjs"), "");
    await expect(explainProps(entry)).rejects.toThrow(/Plug'n'Play/);
  });

  // Reached only after preflight's own hard checks pass: the react-dom
  // version gate was never called by --explain-props before this milestone,
  // so a Solid/PnP project was not the only thing it measured silently.
  it("rejects a project on react-dom 17 the same way the default path does (no regression on the outdated case)", async () => {
    const { root, entry } = isolatedProject("120fps-explain-react17-", {
      "package.json": JSON.stringify({ dependencies: { react: "^17.0.2", "react-dom": "^17.0.2" } }),
      "Card.tsx": "export function Card() { return null; }\n",
    });
    const pkgDir = path.join(root, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "react-dom", version: "17.0.2", main: "index.js" }));
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    await expect(explainProps(entry)).rejects.toThrow(/React 18\+ required/);
  });

  it("does not run the react-dom gate for a .vue target", async () => {
    // Regression lock: rendererFor gates assertReactDomClient the same way
    // buildAndServe does, so a Vue project with no react-dom at all is not
    // rejected for a React-only reason.
    const explained = await explainProps(fixture("vue-project/Button.vue"));
    expect(explained.componentName).toBe("Button");
  });
});

// M78 (excalidraw-F4, reclassified from M81): the wrong-schema finding's real
// cause is that the repository had no node_modules at all, so forwardRef's
// contextual typing had nothing to resolve against. The fix is not a
// prop-extraction change (M81 found the extractor itself correct against a
// real TS 5.9.3 + @types/react); it is that the missing-install gate must
// fire before extraction ever runs, so a user is never handed a confidently
// wrong schema instead of a plain "nothing is installed" message.
describe("excalidraw-F4: missing ambient types caught by the not-installed gate", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a forwardRef component (excalidraw's FilledButton shape) before extracting a schema", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-excalidraw-f4-"));
    tmpDirs.push(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" } }),
    );
    // No node_modules anywhere: no react-dom, no @types/react.
    fs.writeFileSync(
      path.join(root, "FilledButton.tsx"),
      [
        'import { forwardRef } from "react";',
        "export const FilledButton = forwardRef(({ label, disabled, onClick }, ref) => {",
        "  return null;",
        "});",
        "",
      ].join("\n"),
    );

    let thrown: unknown;
    try {
      await explainProps(path.join(root, "FilledButton.tsx"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("no installed dependencies");
    expect(message).toContain(HARD_REMEDY["not-installed"]);
  });
});

// M78 (preact-app-F3, webpack/Next.js shape): a disclosure gap, not a silent
// mismeasurement (120fps genuinely mounts real react-dom for this shape).
// Reached via the same runPreflight-adjacent call added for gate parity, so
// the disclosure is present on every entry path.
describe("--explain-props Preact bundler-alias disclosure", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns when the project's next.config.js aliases react-dom to preact/compat", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-explain-bundler-alias-"));
    tmpDirs.push(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.2.0", "react-dom": "^18.2.0", preact: "^10.19.0" } }),
    );
    fs.writeFileSync(
      path.join(root, "next.config.js"),
      [
        "module.exports = {",
        "  webpack: (config, { dev, isServer }) => {",
        "    if (!dev && !isServer) {",
        "      Object.assign(config.resolve.alias, { react: 'preact/compat', 'react-dom': 'preact/compat' });",
        "    }",
        "    return config;",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const pkgDir = path.join(root, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "react-dom", version: "18.2.0", main: "index.js" }));
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(root, "Card.tsx"), "export function Card() { return null; }\n");

    const explained = await explainProps(path.join(root, "Card.tsx"));
    const configFile = path.join(root, "next.config.js");
    expect(explained.warnings).toContain(BUNDLER_PREACT_ALIAS_WARNING(configFile, "preact/compat"));
  });
});

// --- C2: progress heartbeat ---

describe("progress heartbeat", () => {
  it("writes one line per marker outside CI mode", () => {
    const written: string[] = [];
    const report = resolveProgressReporter({}, (s) => written.push(s));
    report("mount: 8 combos");
    report("rerender: 8 combos");
    expect(written).toEqual(["mount: 8 combos\n", "rerender: 8 combos\n"]);
  });

  it("emits nothing in --ci mode", () => {
    const written: string[] = [];
    const report = resolveProgressReporter({ ci: true }, (s) => written.push(s));
    report("mount: 8 combos");
    expect(written).toEqual([]);
  });

  it("routes to a caller-supplied sink instead of stdout", () => {
    const seen: string[] = [];
    const written: string[] = [];
    const report = resolveProgressReporter(
      { onProgress: (l) => seen.push(l) },
      (s) => written.push(s),
    );
    report("explore: 6 combos");
    expect(seen).toEqual(["explore: 6 combos"]);
    expect(written).toEqual([]);
  });

  it("suppresses a caller-supplied sink in CI mode too", () => {
    const seen: string[] = [];
    const report = resolveProgressReporter({ ci: true, onProgress: (l) => seen.push(l) });
    report("mount: 1 combo");
    expect(seen).toEqual([]);
  });
});

// --- C3: total wall clock ---

describe("total wall clock", () => {
  it("formats sub-minute runs in seconds", () => {
    expect(formatWallClock(42_100)).toBe("Total: 42.1s");
    expect(formatWallClock(1_500)).toBe("Total: 1.5s");
    expect(formatWallClock(0)).toBe("Total: 0.0s");
  });

  it("formats longer runs as minutes and seconds", () => {
    expect(formatWallClock(252_000)).toBe("Total: 4m 12s");
    expect(formatWallClock(60_000)).toBe("Total: 1m 0s");
    expect(formatWallClock(3_723_000)).toBe("Total: 62m 3s");
  });
});

// --- C4: provider-hook detection ---

describe("provider detection", () => {
  it("recognizes known provider libraries including sub-paths", () => {
    expect(detectProviderImport("next-intl")?.hook).toBe("useTranslations");
    expect(detectProviderImport("next-intl/client")?.source).toBe("next-intl");
    expect(detectProviderImport("react-i18next")?.hook).toBe("useTranslation");
    expect(detectProviderImport("react-redux")?.hook).toBe("useSelector");
    expect(detectProviderImport("@tanstack/react-query")?.hook).toBe("useQuery");
    expect(detectProviderImport("react")).toBeUndefined();
    expect(detectProviderImport("./local")).toBeUndefined();
  });

  // M72: routing/meta-framework libraries whose hooks throw outside their
  // router or route context, the same shape as the four existing entries.
  it("recognizes routing and meta-framework provider libraries", () => {
    expect(detectProviderImport("react-router")?.hook).toBe("useNavigate");
    expect(detectProviderImport("react-router-dom")?.hook).toBe("useNavigate");
    expect(detectProviderImport("react-router-dom/client")?.source).toBe("react-router-dom");
    expect(detectProviderImport("@remix-run/react")?.hook).toBe("useLoaderData");
    expect(detectProviderImport("gatsby")?.hook).toBe("useStaticQuery");
    expect(detectProviderImport("@tanstack/react-router")?.hook).toBe("useRouter");
    expect(detectProviderImport("@tanstack/react-start")?.hook).toBe("useRouter");
  });

  it("records a package provider import from the walked graph", () => {
    const result = runPreflight({
      projectRoot: path.resolve("fixtures"),
      entries: [fixture("m65/intl-widget.tsx")],
    });
    expect(result.providers.map((p) => p.source)).toContain("next-intl");
    expect(providerCandidateLabels(result.providers)).toContain("next-intl (useTranslations)");
  });

  it("records a local context module that throws in its hook", () => {
    const result = runPreflight({
      projectRoot: path.resolve("fixtures"),
      entries: [fixture("m65/workbench-consumer.tsx")],
    });
    const local = result.providers.find((p) => p.local);
    expect(local?.source).toMatch(/workbench-store\.tsx$/);
    expect(local?.hook).toBe("useWorkbench");
  });

  it("does not flag a local context module that never throws", () => {
    const result = runPreflight({
      projectRoot: path.resolve("fixtures"),
      entries: [fixture("m65/healthy-consumer.tsx")],
    });
    expect(result.providers).toEqual([]);
  });

  it("names the candidates in the render-error hint", () => {
    // M79 (4a): the provider hint is gated on a captured page-error message
    // that actually looks provider/context-shaped.
    const report = {
      combos: [{ pageErrors: ["useTranslations must be used within a NextIntlClientProvider"] }],
      providerCandidates: ["next-intl (useTranslations)"],
    } as unknown as Report;
    const text = formatHints(["renderError"], report);
    expect(text).toContain("component imports next-intl (useTranslations)");
    expect(text).toContain("--wrap");
    expect(text).toContain("120fps.setup.tsx");
  });

  it("prints the plain render-error hint when nothing was detected", () => {
    const text = formatHints(["renderError"]);
    expect(text).toContain("threw instead of rendering");
    expect(text).not.toContain("component imports");
  });
});
