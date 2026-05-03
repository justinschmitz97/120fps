---
kind: milestone
status: done
tests: [test/unit/fixture.test.ts, test/unit/fixture-harden.test.ts, test/e2e/fixture.test.ts, test/e2e/fixture-harden.test.ts]
---

## Purpose

Many UI components are compound — they export multiple sub-components that must be composed together to produce a meaningful render. Examples: `Accordion` + `AccordionItem` + `AccordionTrigger` + `AccordionContent`, `Tabs` + `TabList` + `Tab` + `TabPanel`, `Dialog` + `DialogTrigger` + `DialogContent`. When the tool mounts only the root export with empty props, it gets an inert shell (0 interactions, minimal DOM). M7 adds fixture support so composed components can be measured with realistic children.

## Builds on

M6 (full pipeline). The pipeline auto-extracts props and generates combinations for a single export. M7 adds an alternative entry path: a user-authored fixture file that renders the component in a representative composition.

## Contract

### MUST

- Accept a fixture file as CLI input: `120fps ./accordion.fixture.tsx`. Any `.fixture.tsx` or `.fixture.ts` file is treated as a composed fixture rather than a raw component.
- A fixture file default-exports a React component (the "scene"). The scene receives no props — it self-contains all composition, state, and representative data.
- When a fixture is provided, skip prop extraction and combination generation entirely. The pipeline mounts the scene once (1 combo: `{}`), then runs discovery + exploration + metrics as normal.
- The fixture's default export is what gets mounted via the Control API (`__120fps.mount({})`).
- Fixture files resolve imports relative to their own project (same tsconfig alias + node_modules resolution as M6's harness).
- Accept a `--fixture` flag on any component path: `120fps ./accordion.tsx --fixture ./accordion.fixture.tsx`. In this mode, mount the fixture for measurement but use the component path for metadata (componentName).
- When `--fixture` is provided, the report's `componentName` comes from the component path (not the fixture), and the fixture path is recorded in the JSON report as `fixturePath`.
- Auto-detection: if `<component>.fixture.tsx` or `.fixture.ts` exists adjacent to the target component, use it automatically without `--fixture`. Example: `120fps ./accordion.tsx` finds `./accordion.fixture.tsx` in the same directory and uses it.
- Auto-detection is silent (no warning/prompt). The report records `fixtureAutoDetected: true`.
- Terminal hint when 0 interactions found and no fixture exists: "0 interactions found. Consider creating `<component>.fixture.tsx` with composed children."

### MUST NOT

- Require any specific export naming convention beyond default export from the fixture.
- Modify the fixture file.
- Require the fixture to import from `120fps` or any test utility — it's just a React component file.
- Break backward compatibility: a `.tsx` file without the `.fixture` naming convention still works exactly as before (prop extraction + auto-combos).
- Pass props to the fixture scene. Fixtures are self-contained by design. The tool mounts with `{}` always.

### Invariants

- Fixture scenes are measured identically to auto-generated combos: same CDP tracing, same calibration, same interaction discovery + exploration, same verdicts.
- All existing tests continue to pass unchanged.
- A fixture that throws during render does not crash the pipeline — React catches the error, and the report completes with degraded data.
- The `--fixture` flag and auto-detection do not change `--samples` behavior: sample count still applies to the single fixture combo.

## Design

### Detection logic (in `analyze()`)

```
1. Is the input path `*.fixture.tsx` or `*.fixture.ts`? → fixture mode, single-combo pipeline.
2. Is `--fixture <path>` provided (or options.fixturePath)? → use that fixture for mounting, component path for metadata.
3. Does `<stem>.fixture.tsx` or `<stem>.fixture.ts` exist adjacent to the component? → auto-use fixture.
4. None of the above → current behavior (prop extraction + combos).
```

Implemented via `isFixturePath(path)` and `detectFixture(componentPath)` in `src/analyze.ts`.

### Harness entry (fixture mode)

The existing `buildAndServe()` handles fixture files via the standard `detectComponentExport()` — fixtures use default export, which is already supported. The harness generates `import Scene from "/<fixture-path>"` and mounts with `React.createElement(Scene, props)`.

No prop extraction. No combination generation. `combos = [{}]`.

### Fixture authoring (user-facing contract)

A fixture is a normal React file. The user composes whatever representative state they want measured:

```tsx
// accordion.fixture.tsx
export default function AccordionScene() {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="item-1">
        <AccordionTrigger>Section 1</AccordionTrigger>
        <AccordionContent>Content 1</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
```

No imports from 120fps. No decorators. No config objects.

### Report changes

- `Report.fixturePath?: string` — set when fixture was used.
- `Report.fixtureAutoDetected?: boolean` — true if fixture was found via adjacency, false if explicit `--fixture` or direct `.fixture.tsx` input.
- `ComboReport` when fixture: `comboIndex: 0`, `props: {}`, all other fields normal.

### CLI changes

- `--fixture <path>` flag added to `parseArgs`.
- `CliArgs.fixturePath?: string` added.
- Help text includes `--fixture` option.
- Fixture path validated (exists check) before pipeline starts.

## Test count

37 new tests (13 unit + 5 e2e core + 18 unit hardening + 6 e2e hardening = 42 total M7 tests). 306 total (262 unit + 44 e2e fixture).
