import type { Report } from "./types.js";
import { isSuperlinearGrowth } from "./stats.js";

// A hint is documentation attached to a finding class, never advice inferred from code.
export type HintId =
  | "memoBailout"
  | "contextFanOut"
  | "callbackIdentity"
  | "portalOrphans"
  | "leakSuspected"
  | "churnDegradation"
  | "superlinearGrowth"
  | "budgetBreach"
  | "domFlat"
  | "measuredState"
  | "renderError"
  | "harnessFault"
  // Mount aborts whose remedy is neither a React provider nor a props preset.
  | "vuePluginGlobals"
  | "vueSlotContent"
  // A mount abort has no timings and no `Page errors` block for `renderError` to cite.
  | "mountAbortProvider"
  // Every scale point rendered nothing and nothing threw, so `renderError` would lie.
  | "curveRenderedNothing"
  // The numbers are real and the graphic is not.
  | "unresolvedSprite"
  // A read of undefined in an SFC render frame, where the component itself calls `inject(`.
  | "vueProvideInject"
  // An identifier nothing defined, in a run whose vite config declared plugins.
  | "vitePluginsNotExecuted";

export interface Hint {
  id: HintId;
  title: string;
  lines: string[];
  anchor: string;
}

export const HINTS: Record<HintId, Hint> = {
  memoBailout: {
    id: "memoBailout",
    title: "memo() is not holding",
    lines: [
      "A memoized child re-rendered with equal-looking props, so something in them is a new",
      "reference each time. Hoist the object or array literal out of the parent's render, or",
      "wrap it in useMemo. If the prop is a callback, see the callback-identity hint.",
    ],
    anchor: "#memo-bailout",
  },
  contextFanOut: {
    id: "contextFanOut",
    title: "context updates reach more of the tree than they need to",
    lines: [
      "Every consumer re-renders when the provider's value changes identity. Wrap the value",
      "passed to Provider in useMemo, and split one wide context into a value context and a",
      "setter context so consumers that only dispatch stop re-rendering on every read.",
    ],
    anchor: "#context-fan-out",
  },
  callbackIdentity: {
    id: "callbackIdentity",
    title: "callbacks change identity between renders",
    lines: [
      "An inline arrow is a new function on every render, which defeats memo on the child that",
      "receives it. Wrap it in useCallback with the values it closes over as deps, or move the",
      "handler out of the component when it closes over nothing.",
    ],
    anchor: "#callback-identity",
  },
  portalOrphans: {
    id: "portalOrphans",
    title: "portal content outlived its component",
    lines: [
      "Nodes the component portalled onto document.body were still there after unmount. Return",
      "a cleanup from the effect that created the container, and remove the container element",
      "itself: React removes what it rendered, not a host node you appended.",
    ],
    anchor: "#portal-orphans",
  },
  leakSuspected: {
    id: "leakSuspected",
    title: "heap grows on every mount/unmount cycle",
    lines: [
      "Something outlives the component. Return cleanups from effects that add listeners,",
      "timers, observers or subscriptions, and abort in-flight requests on unmount. Take a",
      "heap snapshot across two cycles in DevTools to see what is retaining the tree.",
    ],
    anchor: "#leak-suspected",
  },
  churnDegradation: {
    id: "churnDegradation",
    title: "repeated rerenders get slower as they go",
    lines: [
      "Later rerenders cost more than the first, so state is accumulating rather than",
      "replacing. Check for arrays or maps appended to on every update, and for effects that",
      "add a subscription without removing the previous one.",
    ],
    anchor: "#churn-degradation",
  },
  superlinearGrowth: {
    id: "superlinearGrowth",
    title: "cost grows faster than the data",
    lines: [
      "Doubling the input more than doubles the time, so there is work per item that touches",
      "every other item. Look for a filter, find, or includes inside a map over the same list,",
      "and for layout reads interleaved with writes inside the loop.",
    ],
    anchor: "#superlinear-growth",
  },
  budgetBreach: {
    id: "budgetBreach",
    title: "over the budget for its tier",
    lines: [
      "Budgets are per tier, and tiers come from DOM size, portals and animation. Start with",
      "the cost attribution in the JSON report: it names which package or which of your own",
      "files owns the time, which is usually a faster read than profiling from scratch.",
    ],
    anchor: "#tier-budgets",
  },
  domFlat: {
    id: "domFlat",
    title: "the scaling prop did not change the DOM",
    lines: [
      "Scale points were measured but the node count never moved, so the growth class",
      "describes nothing that was rendered. Check that the prop actually drives what renders,",
      "or point --curve at the prop that does.",
    ],
    anchor: "#scaling-curves",
  },
  renderError: {
    id: "renderError",
    title: "the component threw instead of rendering",
    lines: [
      "Nothing reached the DOM and the page raised an uncaught error, so the timings describe a",
      "broken tree. Read the page errors above: a missing provider needs --wrap pointing at a",
      "setup module, and an undefined prop needs a <stem>.props.tsx preset supplying a real value.",
    ],
    anchor: "#render-errors",
  },
  harnessFault: {
    id: "harnessFault",
    title: "a synthesized value, not the component, caused the crash",
    lines: [
      "The combo's page error traces back to a value 120fps chose for you, not something your",
      "code passed. It is already excluded from the verdict. Add a <stem>.props.tsx preset naming",
      "the prop if you want that combo measured with a real value instead of excluded.",
    ],
    anchor: "#harness-fault",
  },
  measuredState: {
    id: "measuredState",
    title: "the numbers describe a loading state",
    lines: [
      "The component was still fetching or still settling when the sample window closed, so",
      "these numbers are the skeleton's. Add a setup export to your wrapper module that stubs",
      "the request before first render: see the async wrapper setup section.",
    ],
    anchor: "#async-wrapper-setup",
  },
  vuePluginGlobals: {
    id: "vuePluginGlobals",
    title: "the component reads a global that a Vue plugin installs",
    lines: [
      "The harness mounts with a bare createApp(): no app.use(...) ran, so a plugin's global",
      "properties ($primevue and the like) and its provided values are absent, and the component",
      "threw reading one. Add a 120fps.setup.vue wrapper and install the plugin from its own",
      "setup: getCurrentInstance()?.appContext.app.use(Plugin). The wrapper renders inside the",
      "same app the component mounts in.",
    ],
    anchor: "#provider-wrapper",
  },
  vueSlotContent: {
    id: "vueSlotContent",
    title: "the component calls a slot nothing was composed into",
    lines: [
      "$slots was read as content the component's own render depends on, and the harness mounted",
      "it alone. Add the children in a <stem>.fixture.vue and pass --fixture (it is also",
      "auto-detected next to the component): one SFC per component leaves a compound scene with",
      "nothing to infer from.",
    ],
    anchor: "#vue",
  },
  mountAbortProvider: {
    id: "mountAbortProvider",
    title: "the component asked for a provider before it could render",
    lines: [
      "The mount was aborted, so there are no timings and no page-error block below: the abort",
      "message above is the whole record. It names a context or injection the component reads and",
      "the harness does not supply. Add a wrapper module that renders the provider and point --wrap",
      "at it (120fps.setup.tsx, or 120fps.setup.vue for an SFC).",
    ],
    anchor: "#provider-wrapper",
  },
  curveRenderedNothing: {
    id: "curveRenderedNothing",
    title: "the component rendered nothing at every scale point",
    lines: [
      "No N produced a single DOM node, so the growth class describes a component that never",
      "rendered rather than one that scales flat. Nothing was thrown: the usual cause is context",
      "the component reads and the harness does not supply. Point --wrap at a setup module that",
      "renders the provider, or check that the scaling prop is the one that drives the render.",
    ],
    anchor: "#scaling-curves",
  },
  unresolvedSprite: {
    id: "unresolvedSprite",
    title: "an svg reference points at a sprite the document never defines",
    lines: [
      "The render pays for an <svg> and a <use> element that draw nothing, because the sprite sheet",
      "those ids live in is injected by your application shell, not by this component. Add a",
      "120fps.setup.tsx wrapper whose top-level side effect injects the same sheet and point --wrap",
      "at it, so the measured render draws what production draws.",
    ],
    anchor: "#provider-wrapper",
  },
  vueProvideInject: {
    id: "vueProvideInject",
    title: "the component reads an injected value nothing provided",
    lines: [
      "The abort reads a property of undefined inside the component's own render, and this",
      "component's setup block calls inject(). The harness mounts the component alone, so no",
      "ancestor ran provide() for that key. Add a 120fps.setup.vue whose own setup calls",
      "provide() with the same key and value the application supplies, and point --wrap at it.",
    ],
    anchor: "#provider-wrapper",
  },
  vitePluginsNotExecuted: {
    id: "vitePluginsNotExecuted",
    title: "a global the config's plugins would have defined is missing",
    lines: [
      "The abort names an identifier nothing defined. The project's Vite config declares plugins,",
      "which the harness reads and never executes, so a compile-time macro or auto-import they",
      "install never reaches the transformed source. The harness resolves what an auto-import map",
      "on disk (auto-imports.d.ts) declares; anything else has to be written out by hand in the",
      "component, or measured on a component that does not depend on the plugin.",
    ],
    anchor: "#project-transforms",
  },
};

const VUE_PLUGIN_GLOBAL_SIGNATURE = /\$primevue|app\.use\(|\binject\(\)/i;
// The `$` is what makes the frame evidence of a plugin global.
const VUE_PROXY_FRAME_SIGNATURE = /\bat Proxy\.\$\w/;
// An ordinary render frame: a compiled render function, or a proxy member without `$`.
const VUE_RENDER_FRAME_SIGNATURE = /\b_sfc_render\b|\bat Proxy\.(?!\$)\w/;
// The identifier is the one fact the abort carries about the missing global.
const UNDEFINED_IDENTIFIER_SIGNATURE = /\b([A-Za-z_$][\w$]*) is not defined\b/;
const UNDEFINED_READ_SIGNATURE = /Cannot read propert(?:y|ies) of undefined/i;
const VUE_SLOT_SIGNATURE = /\$slots\b/;

// Narrower than PROVIDER_ERROR_SIGNATURE, which matches "Execution context was destroyed".
const MOUNT_ABORT_PROVIDER_SIGNATURE =
  /useContext|must be used within|<[A-Z]\w*Provider\b|\binject\(/;

// A hint names a cause only from evidence carried here; nothing is inferred.
export interface MountAbortEvidence {
  // The measured SFC's setup block calls `inject(` (`project/vue-sfc.ts`).
  usesInject?: boolean;
  // Keys the harness read and could not honor (`ViteConfigData`, `harness/vite-config.ts`).
  viteConfig?: { file: string; ignoredKeys: string[] };
  // The generated auto-import table the run read, and the names it declares.
  autoImportMap?: { file: string; names: string[] };
}

// Whether the table the run consulted holds the identifier the abort named.
export function autoImportMapLine(
  identifier: string,
  map?: { file: string; names: string[] },
): string {
  if (!map) {
    return (
      `No auto-import map was found in this project, so nothing on disk mapped ${identifier}; ` +
      "the harness had no table to resolve it from."
    );
  }
  return map.names.includes(identifier)
    ? `${map.file} maps ${identifier}, and the harness supplies it only to a module inside this ` +
        "component's own graph that references it without importing it."
    : `${map.file} was consulted and declares no ${identifier}.`;
}

// A mount abort throws before a report exists, so hintsForReport never runs for it.
export function hintsForMountAbort(
  errorText: string,
  evidence?: MountAbortEvidence,
): HintId[] {
  const found = new Set<HintId>();
  if (VUE_SLOT_SIGNATURE.test(errorText)) found.add("vueSlotContent");
  if (
    VUE_PLUGIN_GLOBAL_SIGNATURE.test(errorText) ||
    (VUE_PROXY_FRAME_SIGNATURE.test(errorText) && UNDEFINED_READ_SIGNATURE.test(errorText))
  ) {
    found.add("vuePluginGlobals");
  }
  // Named only because the run read an `inject(` call in the measured component.
  if (
    evidence?.usesInject === true &&
    !found.has("vuePluginGlobals") &&
    VUE_RENDER_FRAME_SIGNATURE.test(errorText) &&
    UNDEFINED_READ_SIGNATURE.test(errorText)
  ) {
    found.add("vueProvideInject");
  }
  // An empty ignored list means the config declared nothing the harness dropped.
  if (
    UNDEFINED_IDENTIFIER_SIGNATURE.test(errorText) &&
    (evidence?.viteConfig?.ignoredKeys ?? []).includes("plugins")
  ) {
    found.add("vitePluginsNotExecuted");
  }
  // A stack naming none of these gets no guess at all.
  if (MOUNT_ABORT_PROVIDER_SIGNATURE.test(errorText)) found.add("mountAbortProvider");
  const order = Object.keys(HINTS) as HintId[];
  return order.filter((id) => found.has(id));
}

// The catalog is static copy, so this run's own facts arrive as extra lines.
export function formatMountAbortHints(
  errorText: string,
  evidence?: MountAbortEvidence,
): string {
  const ids = hintsForMountAbort(errorText, evidence);
  const identifier = UNDEFINED_IDENTIFIER_SIGNATURE.exec(errorText)?.[1];
  const configFile = evidence?.viteConfig?.file;
  const extra: Partial<Record<HintId, string[]>> =
    ids.includes("vitePluginsNotExecuted") && configFile && identifier
      ? {
          vitePluginsNotExecuted: [
            `${configFile} declares plugins, which the harness read but did not execute; ` +
              `nothing defined ${identifier}.`,
            autoImportMapLine(identifier, evidence?.autoImportMap),
          ],
        }
      : {};
  return formatHints(ids, undefined, extra);
}

// Derived from the report alone, never from code the tool did not measure.
export function hintsForReport(report: Report): HintId[] {
  const found = new Set<HintId>();

  for (const combo of report.combos) {
    const optimizations = combo.reactOptimizations;
    if (optimizations?.memoBailout) found.add("memoBailout");
    if (optimizations?.contextFanOut) found.add("contextFanOut");
    if ((optimizations?.callbackIdentityDeltas?.length ?? 0) > 0) found.add("callbackIdentity");
    if ((optimizations?.portalOrphans ?? 0) > 0) found.add("portalOrphans");
    // A finding about the document, carried on whichever combos observed it.
    if ((combo.unresolvedSpriteRefs?.length ?? 0) > 0) found.add("unresolvedSprite");

    // A render error exceeds no budget, so the budget hint would cite a tree that never was.
    if (combo.renderHealth === "error") {
      found.add(combo.harnessFault ? "harnessFault" : "renderError");
    } else if (combo.verdict === "fail") found.add("budgetBreach");
    if (combo.measuredState && combo.measuredState !== "settled") found.add("measuredState");

    for (const curve of [combo.scalingCurve, combo.rerenderScalingCurve]) {
      if (isSuperlinearGrowth(curve)) found.add("superlinearGrowth");
    }
  }

  const isolation = report.isolation;
  if (isolation?.memory?.leakSuspected) found.add("leakSuspected");
  if ((isolation?.rerender?.churnDegradation ?? 0) > 0) found.add("churnDegradation");

  const curveReport = report.scalingCurveReport;
  // Curve mode has no combos, so the per-combo renderHealth gate above never fires here.
  const curveRenderError =
    (curveReport?.renderErrorPoints?.length ?? 0) > 0 ||
    // The all-empty marker shares this prefix but nothing threw, so `\d` excludes it.
    (report.warnings ?? []).some((w) => /^scale point N=\d/.test(w));
  if (curveRenderError) found.add("renderError");
  // `points` is optional on a hand-built report, so `.length` is never read unguarded.
  const curvePoints = curveReport?.points ?? [];
  const curveRenderedNothing =
    curvePoints.length > 0 && curvePoints.every((p) => p.domNodeCount === 0);
  // domFlat's remedy is wrong when a render error or an all-empty curve explains the flatness.
  if (curveReport?.domFlat && !curveRenderError && !curveRenderedNothing) found.add("domFlat");
  if (curveRenderedNothing && !curveRenderError) found.add("curveRenderedNothing");
  // Both classes print on the curve screen's `Growth:` line, so no hint cites an unseen one.
  for (const curve of [curveReport?.mountCurve, curveReport?.rerenderCurve]) {
    if (isSuperlinearGrowth(curve)) found.add("superlinearGrowth");
  }

  // Stable order so the terminal output does not reshuffle between runs.
  const order = Object.keys(HINTS) as HintId[];
  return order.filter((id) => found.has(id));
}

// First-run users read 14ms and think their button takes 14ms in production.
export const MEASUREMENT_BASIS_LINE =
  "Measured under 4x CPU throttle; budgets are calibrated for these conditions. " +
  "Numbers are comparative, not production wall-clock.";

// Named only once a render failed; a healthy run is never told about an import that behaved.
export const PROVIDER_HINT_LINE = (candidate: string): string =>
  `component imports ${candidate}: likely needs a provider wrapper; see --wrap / 120fps.setup.tsx`;

// "component imports X" is false for a candidate reached through an intermediate file.
export const PROVIDER_HINT_LINE_TRANSITIVE = (candidate: string): string =>
  `component's import graph reaches ${candidate}: likely needs a provider wrapper; see --wrap / 120fps.setup.tsx`;

// Deliberately loose: the goal is withholding a wrong guess, never proving a right one.
const PROVIDER_ERROR_SIGNATURE = /provider|context/i;

// Curve mode has no combos; its capture is renderErrorPoints (pipeline/modes/curve.ts).
function capturedErrorTexts(report: Report): string[] {
  const texts: string[] = [];
  for (const combo of report.combos) {
    if (combo.pageErrors) texts.push(...combo.pageErrors);
  }
  for (const point of report.scalingCurveReport?.renderErrorPoints ?? []) {
    texts.push(...point.pageErrors);
  }
  for (const warning of report.warnings ?? []) {
    if (/^scale point N=/.test(warning)) texts.push(warning);
  }
  return texts;
}

// A thrown error often names the symbol it needed, which then leads the candidate order.
const NAMED_PROVIDER_SYMBOL = /\b([A-Z]\w*(?:Provider|Context))\b/;

function namedProviderSymbol(texts: string[]): string | undefined {
  for (const text of texts) {
    const match = NAMED_PROVIDER_SYMBOL.exec(text);
    if (match) return match[1];
  }
  return undefined;
}

// A candidate label is a path or package name, so punctuation and case must not defeat it.
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Only reorders, so this can never manufacture a candidate that was not found.
function rankProviderCandidates(candidates: string[], texts: string[]): string[] {
  const symbol = namedProviderSymbol(texts);
  if (!symbol) return candidates;
  const needle = normalizeForMatch(symbol.replace(/(?:Provider|Context)$/, ""));
  if (!needle) return candidates;
  return [...candidates].sort((a, b) => {
    const aMatch = normalizeForMatch(a).includes(needle) ? 0 : 1;
    const bMatch = normalizeForMatch(b).includes(needle) ? 0 : 1;
    return aMatch - bMatch;
  });
}

function extraHintLines(id: HintId, report: Report | undefined): string[] {
  // The all-empty curve reaches the same candidate list a render error does.
  if (id === "curveRenderedNothing" && report) {
    return (report.providerCandidates ?? []).map((candidate) =>
      (report.transitiveProviderCandidates ?? []).includes(candidate)
        ? PROVIDER_HINT_LINE_TRANSITIVE(candidate)
        : PROVIDER_HINT_LINE(candidate),
    );
  }
  if (id !== "renderError" || !report) return [];
  const texts = capturedErrorTexts(report);
  // A wrong guess on top of appendPageErrors's correct disclosure is worse than none.
  if (!texts.some((text) => PROVIDER_ERROR_SIGNATURE.test(text))) return [];
  const ranked = rankProviderCandidates(report.providerCandidates ?? [], texts);
  // Wording only; which candidate leads is unaffected.
  const transitive = new Set(report.transitiveProviderCandidates ?? []);
  return ranked.map((candidate) =>
    transitive.has(candidate) ? PROVIDER_HINT_LINE_TRANSITIVE(candidate) : PROVIDER_HINT_LINE(candidate),
  );
}

export function formatHints(
  ids: HintId[],
  report?: Report,
  // Run-specific lines the catalog cannot carry, keyed by the hint they belong under.
  extra?: Partial<Record<HintId, string[]>>,
): string {
  if (ids.length === 0) return "";
  const lines: string[] = ["", "What to do about it:"];
  for (const id of ids) {
    const hint = HINTS[id];
    lines.push("", `  ${hint.title}`);
    for (const line of hint.lines) lines.push(`    ${line}`);
    for (const line of extraHintLines(id, report)) lines.push(`    ${line}`);
    for (const line of extra?.[id] ?? []) lines.push(`    ${line}`);
    lines.push(`    README ${hint.anchor}`);
  }
  return lines.join("\n");
}
