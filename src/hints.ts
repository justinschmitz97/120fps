import { isSuperlinearGrowth } from "./metrics.js";
import type { Report } from "./report.js";

// A hint is documentation attached to a diagnosis, not advice generated from
// inspecting the user's code. Each is derived from the finding class alone, and
// each names an *action* rather than restating the finding.
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
  // M105 I12 (primevue-F2): two mount-phase aborts whose remedy is neither a
  // React provider nor a props preset, so `renderError`'s text fits neither.
  | "vuePluginGlobals"
  | "vueSlotContent"
  // M106 C4 (calcom-F5): the numbers are real and the graphic is not.
  | "unresolvedSprite";

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
};

// M105 I12 (primevue-F2): a mount-phase abort throws before any report exists,
// so `hintsForReport` — which consumes a built report — never runs for it and
// the catalog entry for exactly this failure was unreachable. This reads the
// one thing such a failure does have: the abort's own message text.
//
// The Select repro's text never contains "$primevue"; its stack frame reads
// `at Proxy.$variant`. A `Proxy.` frame comes from Vue's own component proxy,
// so that frame together with a read of `undefined` identifies a missing
// injected global without needing the plugin's name to appear.
const VUE_PLUGIN_GLOBAL_SIGNATURE = /\$primevue|app\.use\(|\binject\(\)/i;
const VUE_PROXY_FRAME_SIGNATURE = /\bat Proxy\.\$?\w/;
const UNDEFINED_READ_SIGNATURE = /Cannot read propert(?:y|ies) of undefined/i;
const VUE_SLOT_SIGNATURE = /\$slots\b/;

export function hintsForMountAbort(errorText: string): HintId[] {
  const found = new Set<HintId>();
  if (VUE_SLOT_SIGNATURE.test(errorText)) found.add("vueSlotContent");
  if (
    VUE_PLUGIN_GLOBAL_SIGNATURE.test(errorText) ||
    (VUE_PROXY_FRAME_SIGNATURE.test(errorText) && UNDEFINED_READ_SIGNATURE.test(errorText))
  ) {
    found.add("vuePluginGlobals");
  }
  // The same loose provider/context signature `extraHintLines` uses, and the
  // same rule behind it: a stack naming neither gets no guess at all.
  if (PROVIDER_ERROR_SIGNATURE.test(errorText)) found.add("renderError");
  const order = Object.keys(HINTS) as HintId[];
  return order.filter((id) => found.has(id));
}

// Derived from the report alone, so a hint can never depend on a heuristic
// about code the tool did not measure.
export function hintsForReport(report: Report): HintId[] {
  const found = new Set<HintId>();

  for (const combo of report.combos) {
    const optimizations = combo.reactOptimizations;
    if (optimizations?.memoBailout) found.add("memoBailout");
    if (optimizations?.contextFanOut) found.add("contextFanOut");
    if ((optimizations?.callbackIdentityDeltas?.length ?? 0) > 0) found.add("callbackIdentity");
    if ((optimizations?.portalOrphans ?? 0) > 0) found.add("portalOrphans");
    // M106 C4: a finding about the document the component was measured in,
    // carried on whichever combos observed it.
    if ((combo.unresolvedSpriteRefs?.length ?? 0) > 0) found.add("unresolvedSprite");

    // A render error fails the combo without any budget being exceeded, so the
    // budget hint would send the reader to the cost attribution of a tree that
    // never existed. M85: a combo whose crash is already attributed to a
    // harness-synthesized value gets its own, more specific hint instead —
    // "an undefined prop needs a preset" is wrong for a value that is
    // defined, just not the component's fault.
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
  // M79 (4b, chakra-ui-F1) / M83: curve mode has no combos, so the per-combo
  // renderHealth gate above can never fire for it. `renderErrorPoints`
  // (report.ts) is the structural signal a broken scale point leaves behind,
  // populated by runCurveMode at the same point CURVE_RENDER_ERROR_WARNING is
  // pushed, so the two never drift by construction. The "scale point N="
  // string match is kept as a fallback for a report built without the field
  // (e.g. hand-constructed in a test, or from an older JSON report) — the
  // structural field is what production code actually populates.
  const curveRenderError =
    (curveReport?.renderErrorPoints?.length ?? 0) > 0 ||
    (report.warnings ?? []).some((w) => /^scale point N=/.test(w));
  if (curveRenderError) found.add("renderError");
  // A page that threw on every scale point is not evidence the scaling prop
  // fails to drive rendering: domFlat's hint text is actively wrong for that
  // case, so it is suppressed whenever this same report already has a render
  // error to explain the flat curve.
  // M106 C3 (dub-F6), same reasoning one step further: a curve every one of
  // whose points rendered zero nodes did not measure a prop that fails to
  // drive the DOM — it measured a component that never rendered. domFlat's
  // remedy ("point --curve at the prop that does") would send the reader after
  // the wrong thing, and the run's own all-points-empty warning already states
  // what happened.
  // `points` is optional in practice: a hand-built or older report can carry a
  // curve without it, and reading `.length` off it unguarded is what this
  // predicate must never do.
  const curvePoints = curveReport?.points ?? [];
  const curveRenderedNothing =
    curvePoints.length > 0 && curvePoints.every((p) => p.domNodeCount === 0);
  if (curveReport?.domFlat && !curveRenderError && !curveRenderedNothing) found.add("domFlat");
  // Both classes are printed on the curve screen's `Growth:` line, so the hint
  // never cites a classification the reader cannot see.
  for (const curve of [curveReport?.mountCurve, curveReport?.rerenderCurve]) {
    if (isSuperlinearGrowth(curve)) found.add("superlinearGrowth");
  }

  // Stable order so the terminal output does not reshuffle between runs.
  const order = Object.keys(HINTS) as HintId[];
  return order.filter((id) => found.has(id));
}

// One line, every mode: first-run users read 14ms and think their button takes
// 14ms in production.
export const MEASUREMENT_BASIS_LINE =
  "Measured under 4x CPU throttle; budgets are calibrated for these conditions. " +
  "Numbers are comparative, not production wall-clock.";

// M65: the preflight import graph already knows which provider-dependent
// libraries the component pulls in. Named only once a render actually failed:
// a healthy run is never told about an import that behaved.
export const PROVIDER_HINT_LINE = (candidate: string): string =>
  `component imports ${candidate}: likely needs a provider wrapper; see --wrap / 120fps.setup.tsx`;

// M92 gap 3 (dub tooltip.tsx -> rich-text-provider.tsx, verified against
// real source): "component imports X" is false for a candidate reached only
// transitively (an intermediate file the component imports is what imports
// X, not the component itself) -- M92's own governing rule (a printed
// message must be true of the run) applies here exactly as it did to the
// stall-phase hints. Same remedy, honest verb.
export const PROVIDER_HINT_LINE_TRANSITIVE = (candidate: string): string =>
  `component's import graph reaches ${candidate}: likely needs a provider wrapper; see --wrap / 120fps.setup.tsx`;

// M79 (4a, base-ui-F2): loose, deliberately — the goal is withholding a wrong
// guess, not proving a right one. A captured error naming the real cause
// (e.g. Base UI's own "The render prop was provided an invalid React
// element...") must not also print a provider guess that has nothing to do
// with it.
const PROVIDER_ERROR_SIGNATURE = /provider|context/i;

// Combo mode's captured text lives on each combo; curve mode has none of its
// own combos, but its equivalent capture lives structurally in
// scalingCurveReport.renderErrorPoints (report.ts), populated by runCurveMode
// at the same point CURVE_RENDER_ERROR_WARNING (analyze.ts) is pushed into
// report.warnings — both are read here so a report built either way (the
// structural field, or only the formatted warning string) is covered.
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

// M92 (dub button.tsx): a thrown error frequently names the exact symbol it
// needed ("`Tooltip` must be used within `TooltipProvider`"). Extracted so a
// candidate whose own label plausibly matches it can lead the guess instead
// of an unrelated candidate winning purely by discovery order.
const NAMED_PROVIDER_SYMBOL = /\b([A-Z]\w*(?:Provider|Context))\b/;

function namedProviderSymbol(texts: string[]): string | undefined {
  for (const text of texts) {
    const match = NAMED_PROVIDER_SYMBOL.exec(text);
    if (match) return match[1];
  }
  return undefined;
}

// Alphanumeric-only, lowercased comparison: a candidate label is a file path
// or package name ("rich-text-provider.tsx", "next-intl"), never the exact
// PascalCase export the error names, so punctuation/case must not defeat an
// otherwise-real match.
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Only reorders; never adds or removes a candidate, so this can only improve
// which genuine candidate leads, never manufacture a false one.
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
  if (id !== "renderError" || !report) return [];
  const texts = capturedErrorTexts(report);
  // M79 (4a): only emit the provider guess when at least one captured
  // page-error message actually looks provider/context-shaped. When nothing
  // captured mentions either, the reader already has the real captured text
  // from appendPageErrors, and a wrong guess on top of a correct disclosure
  // is worse than no guess.
  if (!texts.some((text) => PROVIDER_ERROR_SIGNATURE.test(text))) return [];
  const ranked = rankProviderCandidates(report.providerCandidates ?? [], texts);
  // M92 gap 3: a candidate the component reaches only transitively gets the
  // honest "import graph reaches" wording instead of "component imports" --
  // ranking (which candidate leads) is unaffected either way.
  const transitive = new Set(report.transitiveProviderCandidates ?? []);
  return ranked.map((candidate) =>
    transitive.has(candidate) ? PROVIDER_HINT_LINE_TRANSITIVE(candidate) : PROVIDER_HINT_LINE(candidate),
  );
}

export function formatHints(ids: HintId[], report?: Report): string {
  if (ids.length === 0) return "";
  const lines: string[] = ["", "What to do about it:"];
  for (const id of ids) {
    const hint = HINTS[id];
    lines.push("", `  ${hint.title}`);
    for (const line of hint.lines) lines.push(`    ${line}`);
    for (const line of extraHintLines(id, report)) lines.push(`    ${line}`);
    lines.push(`    README ${hint.anchor}`);
  }
  return lines.join("\n");
}
