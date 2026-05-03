---
kind: milestone
status: done
tests:
  - test/unit/composition.test.ts
  - test/unit/composition-cli.test.ts
  - test/unit/composition-report.test.ts
  - test/unit/composition-harden.test.ts
  - test/unit/extract-exports.test.ts
---

## Purpose

120fps requires user-authored fixture files to measure composed components (Accordion+Item+Trigger+Content, Dialog+Trigger+Content, Tabs+List+Trigger+Content). This is the biggest friction point for zero-config adoption. The composition structure is already encoded in three signals: export naming conventions, TypeScript prop types, and React runtime errors. M17 infers composition automatically, eliminating fixtures for the vast majority of multi-export components.

## Builds on

M1 (TS Compiler API export extraction + prop schemas). M7 (fixture pipeline as fallback). M6 (analyze orchestrator).

## Contract

### MUST

- Export `inferComposition(exports: ExportInfo[], schemas: Map<string, PropSchema[]>): CompositionTree | null` from a new module `src/composition.ts`.
- `ExportInfo`: `{ name: string, isDefault: boolean }`. Extracted from TS Compiler API alongside existing prop extraction.
- `CompositionTree`: `{ root: string, structure: CompositionNode[], repeatNode?: string, repeatCount: number }`.
- `CompositionNode`: `{ component: string, props: PropCombination, children: CompositionNode[] }`. Recursive tree describing the auto-generated scene.

#### Phase 1 — prefix grouping

- Given exports `[Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription]`, identify root as the export whose name is a prefix of all others. When multiple candidates exist, shortest wins.
- If no shared prefix exists among ≥2 exports, return `null` (not a composed component).
- Single-export files skip composition entirely (existing behavior).
- Case-insensitive prefix matching. Root must be an exact export name, not a substring.

#### Phase 2 — nesting inference

- Classify each non-root export by suffix pattern:
  - `*Item` → direct child of root, repeatable container. Marked as `repeatNode`.
  - `*Trigger`, `*Header`, `*Title`, `*Label` → leaf-like, placed first within nearest container.
  - `*Content`, `*Body`, `*Panel`, `*Description` → content slot, placed after trigger within nearest container.
  - `*List`, `*Group` → intermediate container between root and items/triggers.
  - `*Overlay`, `*Backdrop`, `*Portal` → direct child of root, before other children.
  - No recognized suffix → direct child of root.
- When `*Item` exists: nest trigger/content/description exports inside Item. Repeat Item `repeatCount` times (default 3).
- When `*List`/`*Group` exists: nest triggers inside List, content outside List (tabs pattern: `<Tabs><TabsList><TabsTrigger/></TabsList><TabsContent/></Tabs>`).
- `children` prop in schema confirms a component can wrap others. Components without `children` prop are always leaves.

#### Phase 3 — trial mount with error recovery

- Generate a React element tree from `CompositionTree`. Mount in the harness.
- If mount succeeds and DOM has >0 interactive elements → accept composition.
- If mount throws a React Context error (`"use*Context must be used within"` or `"must be used within a <ComponentName>"`): parse the missing provider name, find it in exports, wrap the failing component, retry. Max 3 retries.
- If mount renders empty DOM (0 nodes inside `#root` beyond the root element): try adding `defaultValue`, `defaultOpen`, `open={true}`, or `value="0"` to root (common Radix patterns). One retry.
- If all retries fail → fall back to existing behavior (warn, suggest fixture).

#### Integration with analyze()

- After prop extraction, before harness build: if file has >1 component export and no fixture detected, call `inferComposition`.
- If composition succeeds: generate harness HTML importing all sub-components, render the composed tree. Skip normal prop combo generation for sub-components. Root component prop combos still apply.
- `Report.autoComposition?: boolean`. `Report.compositionTree?: CompositionTree` (JSON output only).
- `--no-auto-compose` CLI flag → `AnalyzeOptions.skipAutoCompose`.
- Manual fixture always takes precedence over auto-composition.

### MUST NOT

- Import or depend on any component library at build time. All inference is from export names and TS types.
- Attempt more than 3 mount retries per composition attempt.
- Auto-compose when a `*.fixture.tsx` file exists (manual override always wins).
- Modify the user's source files.
- Generate compositions for files with only 1 export.
- Hard-code library-specific component names. All inference is from suffix patterns and naming conventions.

### Invariants

- Single-export components behave identically to M14.
- Files with fixtures behave identically to M7.
- `inferComposition` is pure (no side effects, no browser, no file I/O) except for Phase 3 trial mount.
- Same exports + same schemas → same `CompositionTree` (deterministic before trial mount).
- Failed auto-composition produces a clear warning with the specific failure reason and suggests creating a fixture.

## Design

### Suffix taxonomy

Derived from surveying Radix, shadcn/ui, Headless UI, Ark UI, Mantine, Chakra, React Aria:

| Suffix | Role | Placement | Examples |
|---|---|---|---|
| (none / root) | Provider/root | Outermost | Accordion, Dialog, Tabs, Select |
| Item | Repeatable container | Child of root | AccordionItem, MenuItem |
| Trigger | Interaction target | Inside Item or List | AccordionTrigger, DialogTrigger, TabsTrigger |
| Content, Body, Panel | Content slot | Inside Item or after List | AccordionContent, TabsContent, DialogContent |
| Title, Header, Label | Label element | Inside Content or root | DialogTitle, AlertDialogTitle |
| Description | Secondary text | After Title | DialogDescription |
| List, Group | Container for triggers | Child of root | TabsList, ToggleGroup |
| Overlay, Backdrop | Overlay layer | Child of root, before content | DialogOverlay |
| Portal | Portal wrapper | Child of root | DialogPortal, PopoverPortal |
| Close | Dismiss action | Inside Content | DialogClose |
| Footer, Actions | Bottom slot | Inside Content, after body | DialogFooter |

### Composition templates

**Item-based** (Accordion, Collapsible, Menu):
```
<Root>
  <Item> × N
    <Trigger>Label {i}</Trigger>
    <Content>Content {i}</Content>
  </Item>
</Root>
```

**List-based** (Tabs, ToggleGroup):
```
<Root defaultValue="0">
  <List>
    <Trigger value="{i}"> × N
  </List>
  <Content value="{i}"> × N
</Root>
```

**Portal-based** (Dialog, Popover, Sheet, AlertDialog):
```
<Root open={true}>
  <Trigger>Open</Trigger>
  <Portal>
    <Overlay />
    <Content>
      <Title>Title</Title>
      <Description>Description</Description>
      <Close>Close</Close>
    </Content>
  </Portal>
</Root>
```

**Flat** (no Item, no List — RadioGroup, Select):
```
<Root>
  <Trigger />
  <Content>
    <Item value="{i}"> × N
  </Content>
</Root>
```

Template selection: presence of `*List`/`*Group` → list-based. Presence of `*Item` without `*List` → item-based. Presence of `*Portal`/`*Overlay` → portal-based. Otherwise → flat.

### Error recovery patterns

| Error pattern | Recovery action |
|---|---|
| `must be used within <X>` | Find X in exports, wrap failing subtree in X |
| Empty DOM after mount | Add `open={true}` or `defaultValue="0"` to root |
| `Missing required prop: value` | Add `value="0"` to root |
| `Children must be <X>` | Restructure: move non-X children into an X wrapper |

### Scaling integration

When `repeatNode` is set (typically `*Item`), M8's scaling infrastructure applies: vary repeat count across scale points `[1, 5, 20, 50]` to compute scaling curves for composed components without a `scale()` export.

## Deferred

- Cross-file composition inference (single-file multi-export covers the common case).
- Sub-component prop combo generation (root-level combos with uniform children sufficient for v1).
- Phase 3 trial mount with error recovery (deferred — pure inference covers most patterns).
- Re-exported composition chains (TS Compiler API should follow re-exports; untested).
