---
kind: overview
status: approved
---

# Milestone summaries (M1–M66)

One entry per milestone: what it addressed, why the approach was chosen, and what it achieved.

### M1: harness + prop extraction: done

- **About:** Extract component props via the TS Compiler API and build a Vite harness with a Control API for mount/unmount/rerender measurement.
- **Why this way:** Bundler moduleResolution overrides user tsconfig; React deduplicated via symlink; recursive HOC/class unwrapping; union sampling capped at 64; no user Vite config, no auto-mount.
- **Achievement:** Props extracted and exercised in a controlled Vite harness behind a standardized Control API.

### M2: mount/unmount measurement: done

- **About:** CDP trace per mount/unmount with 4x CPU throttle, 2 warmup runs, 10 samples; frame-driven rather than scheduled.
- **Why this way:** Trace wraps only the action, not harness startup; double-rAF settle fence; throttle only during trace windows; frame pump produces fences at ~2ms instead of 60Hz vsync.
- **Achievement:** Mount/unmount measured via CDP with precise frame-driven timing and configurable throttling.

### M3: interaction discovery: done

- **About:** A single page.evaluate DOM walk discovers interactive elements and ARIA patterns in document order.
- **Why this way:** Selector priority #id > data-testid > nth-of-type, validated via querySelector; opens shadow roots; filters display:none, visibility:hidden, aria-hidden; recognizes ARIA widget patterns.
- **Achievement:** Deterministic identification of all interactive elements, ARIA patterns, and roles for exercise.

### M4: exploration loop: done

- **About:** BFS state graph where state id = FNV-1a hash of #root innerHTML; adaptive deepening; 200-node, 60s, depth-4 limits.
- **Why this way:** Adaptive deepening on edge cost >1.5× median; stop after 10 zero-gain explorations; seeded LCG PRNG for determinism; comboIndex tracking prevents silent misattachment; double-rAF after exercise.
- **Achievement:** Systematic exploration of component state space discovering interactions, transitions, and performance variations.

### M5: CDP metric taxonomy: done

- **About:** Parse trace events single-pass; nesting stack computes totalDuration; fits scaling (linear/quadratic/exponential); measures INP, LayoutShift, heap delta.
- **Why this way:** Nesting stack fixes double-counting; ≥3 distinct n values required for a growth fit; R² > 0.5 validates the model; calibration via DOM insert + offsetHeight; GC per sample.
- **Achievement:** CDP metrics extracted and categorized, including growth fits, INP, and heap delta, disambiguated across Chromium versions.

### M6: CLI + reporting: done

- **About:** analyze() orchestrates the pipeline producing Report v1 JSON with pass/fail verdicts based on thresholds.
- **Why this way:** relativeMount = mount.median / calibration.totalDuration with threshold 2.0; zero-duration calibration hard-fails; --ci mode is JSON-only with exit 1/2; no config files.
- **Achievement:** CLI runs the full measurement pipeline and surfaces results as JSON with verdicts and thresholds.

### M7: composed fixtures: done

- **About:** *.fixture.tsx self-contained scenes mounted with empty props, no 120fps imports or config.
- **Why this way:** Adjacent fixtures auto-detected silently; throwing fixtures degrade instead of crashing; measured identically to auto combos: same tracing, discovery, verdicts.
- **Achievement:** Fixture files usable alongside extracted components with uniform measurement behavior.

### M8: rerender + parameterized scaling: done

- **About:** Measure stable (same props) and rerender (prop-change) scenarios; fixture scale(n) generates combos at [1, 5, 20, 50].
- **Why this way:** scale(n) export via __120fps_scaleN marker prop; rerenderMs default 16 calibrated for 4x throttle; a scaling curve requires ≥2 distinct DOM sizes.
- **Achievement:** Rerender performance measured at variable scales, identifying dominant perf dimensions and scaling patterns.

### M9: portal discovery: done

- **About:** Walk body children beyond #root, with trigger-first probing for aria-haspopup triggers; MutationObserver ≤2s catches async portals.
- **Why this way:** Probing restricted to aria-haspopup triggers (others fast-path skipped); 2 rAF for sync portals, MutationObserver for async; probe only at initial-state discovery, later states body-walk only, for perf.
- **Achievement:** Sync and async portals beyond the main component tree discovered and measured, including multiple/nested portals.

### M10: stress patterns: done

- **About:** Dispatch exercise by type+role: keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, rapid-toggle-11; runs inside the CDP trace per sample.
- **Why this way:** Rapid-toggle count must be odd (11, not 10) to discover state transitions; patterns run inside the trace for every sample; fallback to single-shot without ARIA.
- **Achievement:** Components exercised with realistic patterns revealing performance cliffs that single-shot exercises miss.

### M11: pairwise prop delta: done

- **About:** Hold an anchor combo, flip one prop, diff mount/rerender medians; cap 128 pairs; priority booleans > unions > objects.
- **Why this way:** Reuses already-measured combos via JSON.stringify dedupe; no deltas for function/reactnode/unknown kinds; sorted by |mountDelta| descending; --no-deltas skips the pass.
- **Achievement:** Individual prop performance impacts isolated and ranked by magnitude.

### M12: auto-scaling prop detection: done

- **About:** Zero-config detection of a single prop to scale (items arrays prioritized, else numeric names) with a 5-point sweep.
- **Why this way:** Manual scale() and fixture mode always win; auto-scale disabled in fixtures; normal combos are always measured: scaling is an extra pass.
- **Achievement:** Single properties automatically detected and scaled at configurable points without manual configuration.

### M13: tiered budgets: done

- **About:** Classify component tier from domNodeCount, portal, and animation; apply tier-specific performance budgets instead of flat thresholds.
- **Why this way:** Tier and flat budgets independently calibrated; an explicit threshold overrides only that metric while others keep the tier budget.
- **Achievement:** Verdicts are context-aware per tier, enabling budgets differentiated by component complexity.

### M14: animation detection: done

- **About:** Detect on-page animations via getAnimations(), computed animationName, and allowlisted transitions within #root.
- **Why this way:** Detection on the first sample only (structural, not sample-dependent); no extra browser cycle; scoping to #root excludes the Vite overlay and portals.
- **Achievement:** CSS/WAAPI animations detected automatically for tier-aware budgeting and animation-related verdicts. (Superseded in part by M64's observed-only rule.)

### M15: pointer-drag stress: done

- **About:** Simulate pointer drag: 60 linear pointermoves across the bounding box, vertical/horizontal per aria-orientation (~1s at 60fps).
- **Why this way:** Target priority: role slider > input[type=range] > aria-valuenow > cursor states; rejects HTML5 draggable, touch, and scroll/wheel targets.
- **Achievement:** Performance measured during pointer-drag interactions on sliders and range inputs.

### M16: cost attribution: done

- **About:** Attribute mount scripting time to sources (npm packages, React, user, browser, unattributed) from FunctionCall stack URLs.
- **Why this way:** Pure post-processing on existing traces: no extra capture; handles Vite URL munging and nesting-stack dedupe; no source maps required.
- **Achievement:** Mount scripting cost broken down by source, identifying expensive dependencies and library overhead.

### M17: auto-composition: done

- **About:** Infer composition (flat/list/item/portal) from multi-export file names without fixtures, using a suffix taxonomy from component libraries.
- **Why this way:** Root = the shortest export prefixing all others (case-insensitive); suffix taxonomy (Item, Trigger, Content, …) drawn from Radix/shadcn patterns.
- **Achievement:** Prop combos generated automatically for multi-export files based on export names and composition structure.

### M18: React optimization detection: done

- **About:** Detect React render bailouts, missed memos, unnecessary re-renders, context fan-out, and callback identity changes via a fiber tree walk.
- **Why this way:** Runs in a separate browser with its own probe entry; fiber walk counts renders (memos are cloned on bailout); context behind a __120fpsStable boundary; name filter excludes scaffolding.
- **Achievement:** React-specific optimization findings (memoization, callbacks, context) delivered as post-pipeline analysis separate from measurements.

### M19: Next.js shims: done

- **About:** Replace next/image, next/dynamic, next/link, next/navigation, next/headers, and next-video with self-contained shims for profiling without the framework.
- **Why this way:** Preserve DOM structure and prop forwarding while dropping the framework asset pipeline; tsconfig aliases checked first; gated on hasNextJs.
- **Achievement:** Next.js components profiled via shimmed modules without Next.js build infrastructure or SSR.

### M20: curve mode: done

- **About:** Multi-axis scaling sweep using 6 points [1, 3, 5, 10, 20, 50] for regression fitting instead of the combo pipeline.
- **Why this way:** Auto-activates on a detectScalingProps match; every dimension measured per point (mount/rerender/unmount/DOM/heap/interactions); FAIL on super-linear growth or budget exceed.
- **Achievement:** Scaling behavior analyzed via curve fitting at higher resolution, catching regressions across scale ranges.

### M21: matrix mode: done

- **About:** Full cartesian variant matrix (auto ≤64, capped 256 via all-pairs covering) catches compound prop interaction effects beyond M11's single-prop deltas.
- **Why this way:** Cells ARE combos: the matrix is a pure projection of finished combos; only the 5 hottest are explored; printed rows = hot + failing.
- **Achievement:** Interactions of multiple variant props measured, detecting compound performance effects invisible to delta-based analysis.

### M22: budget CI: done

- **About:** Per-component performance budgets in 120fps.config.json and a baseline in 120fps-baseline.json at package root for CI regression detection.
- **Why this way:** Precedence CLI > per-component > defaults > TIER_BUDGETS; tolerances as percentages (10/15/15/20%); merge-writes preserve other components; committing to git recommended.
- **Achievement:** Budgets and baselines persisted in version control for automated CI regression detection.

### M23: isolated measurements: approved

- **About:** Measure mount, rerender, unmount, memory, and strict-mode phases in isolation with calibrated leak and churn thresholds.
- **Why this way:** StrictMode nested inside the wrapper to measure component cost only; CDP garbage collection used (page gc() unavailable); one browser per phase avoids JIT reuse between samples.
- **Achievement:** Detects memory leaks (8KB/cycle), churn degradation (>2.0), and double-invoke overhead (<110%), with per-phase verdicts.

### M24: debt remediation (2026-07 audit): approved

- **About:** Resolve dogfooding audit findings: tsconfig parsing, export selection ordering, baseline path persistence, stale dir cleanup, multi-path CLI, page-error enrichment.
- **Why this way:** Each fix anchored to an observed failure: config cascades need parseJsonConfigFileContent; export order must be deterministic; baseline paths need a file-ancestor walk; parallel Chromium load caused e2e contention.
- **Achievement:** Baseline paths resolve correctly, export selection deterministic, page exceptions named in timeouts, concurrent Chromium load capped, rapid-toggle handles binary state.

### M25: stylesheet injection: approved

- **About:** Auto-detect global CSS from 8 fixed paths; an explicit `--css` flag overrides cascade order; font readiness settled before throttle.
- **Why this way:** CSS imports go at entry top before component imports; wrapper-imported CSS lands after the --css block to preserve app layer cascade; Vite injects during eval, so window.__120fps presence confirms styles loaded.
- **Achievement:** Unstyled measurement prevented via auto-detected injection; cascade order matches app layering; fonts settled before CPU throttle.

### M26: provider wrapper: approved

- **About:** Wrap the component with providers via `--wrap` or auto-detected `120fps.setup.*`, enabling theme/environment setup without Storybook-style args.
- **Why this way:** ES module import order runs side effects before component render; mount includes provider cost but unmount semantics stay identical to the unwrapped path; overhead traced separately for transparency.
- **Achievement:** Providers measured inside the mount window; viewport customizable via optional export; wrapper CSS/browser packages isolated from Node evaluation.

### M27: React Compiler awareness: approved

- **About:** Detect babel-plugin-react-compiler in project deps; apply the project's own compiler version to profiling; avoid pessimistic double-invoke warnings.
- **Why this way:** Compiler resolved from project node_modules so the version matches production; transform applied server-wide for consistent JSX; react/compiler-runtime pre-bundled to prevent cold optimization during measurement.
- **Achievement:** Measurements recognize compiler memoization; pessimistic overhead warnings omitted; the production compiler version is what gets profiled.

### M28: isolation execution: approved

- **About:** Execute isolated measurement passes per phase (mount, rerender, unmount, memory, strictmode) with warmup 3 and one browser per pass.
- **Why this way:** One pass serves both mount and unmount phases at mount position (cost efficiency); isolation marked in the fingerprint for baseline-comparison filtering; jsx-runtime deps pre-declared to prevent mid-sample cold optimization.
- **Achievement:** Isolated phases execute with shared setup; mode differences detected in baseline comparison; jsx-runtime cold optimization avoided.

### M29: baseline env fingerprint: approved

- **About:** Fingerprint the baseline environment (css, wrapper, compiler, throttle, calibration) to validate comparison soundness; classify as unknown, incompatible, identical, or normalizable.
- **Why this way:** The fingerprint lives on the entry, not the file (entries may come from different conditions); normalizable baselines are divided by their own calibration duration; incompatible comparisons are skipped because mode/css/wrapper/compiler change what is measured.
- **Achievement:** Baselines are honest about measurement conditions; incompatible states skip comparison without failing; pre-M29 baselines marked unknown.

### M30: dogfooding remediation: approved

- **About:** Fixes from testing 0.2.1 across 6 repos: config isolation, template synthesis, composition validation, explore budgets, per-step interaction budgets, context-loss recovery.
- **Why this way:** configFile:false prevents project plugins corrupting the harness Vite; a trial-mount validates the template before calibration; an explore budget cap prevents >35min runs; context loss retries once on a fresh session.
- **Achievement:** Project Vite config isolated; invalid templates caught pre-calibration; 27-combo runs complete in ~20min; context-loss sessions recover with a fresh CDP connection.

### M31: measurement semantics: approved

- **About:** Fix domNodeCount to count component nodes only (excluding harness chrome); cap measured combos at 8 with representative selection (first, last, interior).
- **Why this way:** domNodeCount had included 8 chrome nodes, shifting every tier; the old silent truncation at 16 caused >35min runs; representative selection preserves a stratified sample rather than a prefix.
- **Achievement:** Tier boundaries accurate (≤10 T1, ≤40 T2, >40 T4); representative combo sampling prevents runaway costs; a metrics version bump prevents false regressions.

### M32: developer experience: approved

- **About:** Directory/glob path expansion for multi-component runs; fixture scaffolding for rolled-back compositions; mode reporting in the table; explore-budget CLI flag; distinct JSON naming.
- **Why this way:** PowerShell doesn't expand globs, so Windows needs explicit directory support; users need a fixture starting point; modes auto-activate but weren't labeled; explore options existed without CLI access.
- **Achievement:** A single command runs directories and globs; rolled-back compositions offer a scaffold; the report labels mode and combo cap; four workflow frictions removed.

### M33: frame-derived interaction budgets: approved

- **About:** Frame-based per-event budgets (33/50/67/100ms for T1–T4 at 4x throttle); pointer-drag counted as 60 events, not 1 step; CDP sessions replaced on context loss.
- **Why this way:** One 120fps frame is 8.33ms, which at 4x throttle is 33ms; other tiers derive from 60fps and headroom; pointer-drag's 60 pointermoves are 60 interactions; session replacement avoids a Tracing.start protocol error.
- **Achievement:** Interaction budgets principled from frame time; pointer-drag compared fairly to other patterns; session wedge prevented via replacement.

### M34: profiler overhead reduction: done

- **About:** Harness bookkeeping cost ~60% of per-component run time; GC, DOM-info reads, and trace start/flush dominate under CPU throttle and ran per-sample when per-combo suffices.
- **Why this way:** Suspend throttle for inter-sample GC, DOM-info reads, and unmounts; read domNodeCount/hasAnimation once per combo; cache the Vite deps union; disable file watching on the project-root server.
- **Achievement:** Costs reduced with metrics unchanged within run-to-run noise: reported values identical to pre-M34.

### M35: vsync-free lifecycle measurement: done

- **About:** Each lifecycle sample waited ~33ms per double-rAF fence for the compositor; on badge.tsx, ~80s across mount and rerender phases was pure vsync idle against ~5–10ms of measured work.
- **Why this way:** Launch Chromium with --enable-begin-frame-control and drive frames on demand via HeadlessExperimental.beginFrame (~1.9ms per double-rAF) instead of waiting for 60Hz scheduling.
- **Achievement:** Vsync idle eliminated for lifecycle measurement with frame coverage invariant; animated combos fall back to real vsync pacing.

### M36: shared prop-extraction program: done

- **About:** extractProps rebuilt the ts.Program per call, re-parsing lib.d.ts and the node_modules type graph every time (~0.5–1s per call on real Next.js repos).
- **Why this way:** A memoizing CompilerHost caches parsed files keyed by (fileName, mtime, size); the last program per options key is retained as oldProgram for TypeScript's structure-reuse validation.
- **Achievement:** The parsed graph is shared across extraction calls within the process lifetime, eliminating repeated library re-parsing.

### M37: browser pool across phases and components: done

- **About:** Every measurement phase launched its own Chromium (~0.4–1s); a single run paid 5–8 launches and a multi-component sweep hundreds: but only page state needs to be fresh, not the process.
- **Why this way:** BrowserPool holds at most two processes (driven + vsync), acquired on first use and cached; a fresh browser context gives renderer isolation equivalent to a new browser.
- **Achievement:** Browser launches reduced via cross-component and cross-phase pooling, with a fresh page context per session.

### M38: cross-component sweep server: done

- **About:** Each component booted its own Vite dev server (~3–5s each); harness dirs live inside the project root, so one server can serve all of them.
- **Why this way:** ServerPool acquires once per config tuple (projectRoot, cssFiles, wrapPath, compiler, noShims); later components are served on demand; optimizeDeps.include is frozen at first boot and cached deps reused.
- **Achievement:** Per-component server boots eliminated in multi-path runs; one server's cache and bundle shared across components.

### M39: fingerprint-based baseline reuse: done

- **About:** Identical code in an identical environment yields the same distribution, so unchanged components can be skipped: turning a routine CI sweep (1–5 changed components per commit) into seconds.
- **Why this way:** computeSourceFingerprint hashes order-independently over file paths + content, wrapper, stylesheets, configs, and lockfile; reuse requires matching fingerprints and sameMachineIdentity; calibration is excluded (thermal variance too high).
- **Achievement:** Unchanged components skip re-measurement; CI verdicts come from cache in seconds.

### M40: measured-state integrity: implemented

- **About:** Components fetching on mount render a skeleton first; mount measurement captured that transient state without disclosure, presenting the skeleton's cost as the whole story.
- **Why this way:** A network signal wraps fetch/XHR to detect pending requests; a mutation signal installs a MutationObserver after the fence with a 120ms grace window; both probes run outside traced windows.
- **Achievement:** ComboReport.measuredState classifies settled/pending-network/late-mutation; non-settled combos trigger a disclosure warning instead of a silently wrong report.

### M41: async wrapper setup: implemented

- **About:** M26 excluded async setup, but components fetching on mount need request mocking installed before render; without it M40 flags them pending-network forever.
- **Why this way:** The wrapper module exports an optional setup(): void|Promise<void>, awaited before the control API is exposed; runs once per session outside traced windows; a 15s timeout fails with a readable error.
- **Achievement:** Request mocking and store seeding possible before render, making M40's disclosure actionable and pending components measurable.

### M42: server-only import preflight: implemented

- **About:** Components reaching server-only code or async server components cannot mount in a browser; the failure surfaced minutes into a run as a deep Vite error or readiness timeout.
- **Why this way:** runPreflight walks the import graph (AST-based, no type checker) after prop extraction and before harness/server bootstrap; hard failures on server-only/use server/async export; soft warning on Node builtins.
- **Achievement:** Unmountable components fail in seconds with the explicit import chain and fix guidance, before any harness boot.

### M43: scroll & wheel stress pattern: implemented

- **About:** Scroll jank is the most common real-world interaction complaint, and virtualized lists' entire cost model lives in the scroll handler; M15 had excluded scroll/wheel.
- **Why this way:** Discovery finds scrollable containers (overflow auto/scroll/overlay with actual content overflow); scroll-sweep executes 10 wheel ticks out and back; tick distance adapts to container and viewport size.
- **Achievement:** Scroll/wheel included in stress patterns; virtualized and scrollable components' handler cost and layout jank measured.

### M44: representative prop data (presets): implemented

- **About:** Synthesized props made scenes mount unrealistically: arrays got 3 synthetic items, unions took the first member, render props became stubs; the measurement was real but the scene unrepresentative.
- **Why this way:** A sidecar module `<stem>.props.tsx` exports a prop-name-to-value mapping; literal values are evaluated from the AST; functions and JSX become position markers resolved at render time.
- **Achievement:** Representative prop values supplied without authoring full fixture scenes; presets replace prop pools across all combo generation modes.

### M45: per-environment baselines & baseline workflow: implemented

- **About:** Stop environment mismatches by keying baselines into per-environment slots; cross-environment comparison becomes an explicit fallback instead of an accidental default.
- **Why this way:** Composite keys preserve existing reader shapes, enable clean text merges across branches, and group by component when sorted.
- **Achievement:** CI and laptop baselines live in separate slots; incompatible classifications mostly disappear; M39 reuse operates per slot.

### M46: noise sentinel: implemented

- **About:** Let users distinguish component regressions from machine contention by measuring run-level noise with a probe CV and unstable-metric fraction.
- **Why this way:** Thresholds derived from the existing 15% CV bar; the probe measures repeatability of a fixed arithmetic loop, not calibration.
- **Achievement:** Runs report a noise level; noisy runs show regressions without failing; hostile runs skip baseline comparison.

### M47: volatile DOM normalization: implemented

- **About:** Stop components rendering timestamps/animations from inflating the state graph by measuring the DOM's noise floor before attributing change.
- **Why this way:** Structural addresses instead of object identity so remounts map consistently; a tree-walk hash separates content changes from structure changes.
- **Achievement:** State detection excludes volatile content while preserving structural changes; determinism guaranteed regardless of remounts.

### M48: load-bearing project transforms: implemented

- **About:** Support project plugins (SVGR, vanilla-extract, CSS preprocessors) without loading vite.config; diagnose unsupported transforms with stable codes.
- **Why this way:** Detect transforms from the manifest, resolve from project node_modules, strip server hooks, and pass through build-time logic only.
- **Achievement:** Recognized transforms compile correctly; unsupported ones emit a transform code and diagnosis instead of failing silently.

### M49: compare mode (interleaved A/B): implemented

- **About:** Answer "is my change faster" by measuring the working tree interleaved against git refs in the same thermal window, avoiding sequential bias.
- **Why this way:** Samples interleaved per combo in a single window over the pooled browser; lockfile match enforced; working-tree node_modules linked into the worktree.
- **Achievement:** Compares sample ranges rather than means; mount/unmount/DOM count per combo; distinguishability judged via non-overlapping spreads.

### M50: CI surfacing: implemented

- **About:** Emit GitHub-flavored markdown and JUnit formats so regressions surface in PR comments and CI systems without forge API calls.
- **Why this way:** Pure serializers over Report only: no measurement state, no forge APIs, no network; composes with every mode.
- **Achievement:** Markdown for comments/summaries and JUnit for universal CI rendering, both per-component with noise and cache labels.

### M51: report actionability: implemented

- **About:** Map 10 perf finding classes to 2–3 line hints with a concrete direction and README anchors.
- **Why this way:** Hint bodies enforce imperative verbs; a test resolves anchors against README headings; stable ordering; prose lives in the README, ids in the Report.
- **Achievement:** Every run ends with actionable hints per finding class, plus a mode guide in the README for first-time users.

### M52: explore-phase observer rework: closed: premise falsified by measurement; observers ship as opt-in

- **About:** Measurement falsified the milestone's trace-overhead assumption; the actual explore bottleneck is per-step settle under vsync pacing, not CDP tracing.
- **Why this way:** Measured before switching: trace turned out to be 4% of wall clock, not 91%; the observer path's ratio was 0.93 against a ≤0.50 target.
- **Achievement:** Observers ship as opt-in (presentation-inclusive duration, input delay, script attribution); the default remains the trace path for coverage.

### M53: statistical honesty: implemented

- **About:** Fix P95/CV/fingerprint/churn/curve classification so printed labels match the actual computation; add per-combo warmup.
- **Why this way:** Type-7 quantile matches R/numpy defaults; per-combo warmup costs ≤1 render; parity-split churn; raw-y ranking for curves.
- **Achievement:** P95 is a type-7 quantile, CV uses sample standard deviation, the fingerprint records effective samples, churn respects sample parity.

### M54: baseline reachability: implemented

- **About:** Fix matrix/curve mode interaction with the baseline workflow; add --no-cache; warn when baselines are unreachable instead of silently skipping.
- **Why this way:** Mode is a fingerprinted feature, and disabling one doesn't create unfingerprinted effects; the explicit-enable rule had over-excluded mode-disable flags.
- **Achievement:** Matrix/curve warn instead of silently skipping; --no-cache is discoverable; --curve --matrix errors; the verdict-reuse gate refined.

### M55: ci-report mode coverage: implemented

- **About:** Render meaningful mode-specific CI output for curve/isolation/cached reports instead of placeholder dashes, fulfilling the README's composition promise.
- **Why this way:** A single dispatch point via reportMode; curve shows scale points and growth class; isolation shows phase medians; mode detail folded separately.
- **Achievement:** Pure Report functions render meaningful markdown and JUnit per mode; the warn verdict surfaces across all modes.

### M56: diagnostics & hygiene: implemented

- **About:** Four diagnostic gaps: error messages lacking context and next steps, temp directories accumulating unbounded, the test script mismatching CI, retry exhaustion undefined.
- **Why this way:** An age-based temp sweep needs no lockfiles; npm test made to match the CI-enforced suite; existing error types and warning channels reused.
- **Achievement:** Errors name causes and remediation, temp cleanup prevents disk leaks, npm test runs the unit suite CI enforces.

### M57: Vue support: approved

- **About:** Extend the framework-neutral measurement guarantees to Vue; nine modules were already framework-agnostic, while harness, entry generation, and prop extraction were React-specific.
- **Why this way:** SFC parsing via the project's own compiler; a virtual script for prop resolution; the single-render-site entry and harness trigger mechanism reused; no Vue dependencies shipped.
- **Achievement:** `npx 120fps ./Button.vue` measures a Vue SFC with the same PropSchema[], report shape, control API, tier budgets, and baseline slots as React.

### M58: prop extraction binds to the target component: implemented

- **About:** Props were extracted from the first matching declaration, not the rendered component; six dogfooded components silently measured the wrong props.
- **Why this way:** Collect all candidates first, then select the target by default export, stem-name match, or source order; unwrap call wrappers; a self-consistency guard verifies the binding.
- **Achievement:** Props resolve to the rendered component; the report names the harness import; helpers never shadow exported components.

### M59: render-health gate & always-on page-error surfacing: implemented

- **About:** Broken components (missing context, unpopulated required prop) mounted empty trees but silently reported a pass verdict; page.goto failures had no context.
- **Why this way:** Page errors drained per combo with independent dedupe and cap; fatal means pageerror, not console.error; renderHealth sits alongside the verdict as a reason, not an outcome.
- **Achievement:** Render errors fail the run and name the reason; every page error reaches its producing combo; crashes carry phase/combo/component context.

### M60: prop synthesis honesty: implemented

- **About:** Six prop shapes degraded silently: cva patterns, empty pools, tuples, nested objects, Map/Set, class instances, and computed types synthesized wrong without warning.
- **Why this way:** Strip null/void to reveal unions; order shapes most-specific first; recurse with cycle safety and a property cap; mark degenerate props clearly.
- **Achievement:** All shapes synthesize faithfully or warn with the reason; degenerate props point to the escape hatch (stem.props.tsx); no silent degradation.

### M61: scale-probe transparency + matrix combo cap: implemented

- **About:** The scale probe (4 synthetic combos) mixed with real prop combos in curves; matrix mode ignored --max-combos; probe cost was unbounded (46.9s observed).
- **Why this way:** Probe N marked separately; curves fit only to probe combos or only to real-prop combos, never mixed; distance-from-anchor selection treats axes symmetrically; a cost gate reuses the cheapest point.
- **Achievement:** Scale-probe identity disclosed; one curve per mechanism; --max-combos bounds matrix cells; probe cost gated and disclosed.

### M62: Next.js shim-usage reporting: implemented

- **About:** activeShims and report.nextJsShims were always undefined: the shim redirect alias matched before the external-dep scan, so imports were treated as local and never recorded.
- **Why this way:** Tag shim aliases as distinct from tsconfig paths; report bare specifiers resolved via a shim alias even though they resolve locally; preserve alias precedence.
- **Achievement:** Shim usage reported when imports hit shim modules; the redirect keeps working; tsconfig aliases are never reported as shims.

### M63: curve-fit stability & curve diagnostics: implemented

- **About:** Curve classification flipped between runs with no R² margin; curve failures were unnamed; --curve was silent when no array prop existed; sub-linear growth was labeled exponential.
- **Why this way:** A magnitude gate (growth exponent ≥ 1) plus a residual-share fit gate (50%); violations returned as data; a warning when curve mode cannot activate.
- **Achievement:** Classification stable under noise; curve failures name the violated metric, budget, and crossing N; --curve discloses when it cannot activate.

### M64: verdict & report clarity: implemented

- **About:** Eight output defects from the 2026-08-18 dogfood run where the report stated things untrue of the run: wrong compound-delta sign, unexplained WARN under PASS, a noise warning claiming a baseline comparison that never happened, undiscriminated report mode, empty "React Optimizations" headers, style-inferred animation overriding tiers, attribution reading names off memo/forwardRef wrappers, undocumented exit codes.
- **Why this way:** Warning enrichment at render time from report data; mode as an optional field with derivation fallback (old reports predate it); animation only from observed getAnimations(), never computed style; tier floor (max(sizeTier, T3)) instead of override; page-side rules exported as source strings so they're unit-testable without a browser.
- **Achievement:** Report statements match what actually happened; observed-only animation detection; T3 floor preserves T4 for large animated components; names resolved through memo/forwardRef; --help documents exit codes and --json semantics.

### M65: DX features: implemented

- **About:** No way to preview measured props; silent runs indistinguishable from hangs; provider throws blamed on the component; the stem rule disagreed between resolvers; some exports unreachable.
- **Why this way:** --explain-props reuses analyze's exact resolution order; a heartbeat prints at phase boundaries without a timer; provider candidates attached to render errors; a parse-level #Export split targets specific exports.
- **Achievement:** --explain-props dry-runs props and bindings; progress heartbeat at phases; provider hints on errors; #Export targeting; unified stem normalization.

### M66: attribution honesty: implemented

- **About:** The cost breakdown summed all mounts while the Mount column showed the median of one, and callback identity reported impossible drift for React's referentially-stable dispatch.
- **Why this way:** Attribution accepts nested trace windows and reports the per-sample mean, not a median-sample sum; the stable arm uses cached callbacks instead of fresh functions; a noise floor derives free from arm spread.
- **Achievement:** Attribution covers one mount average with sampleCount disclosed; callback identity measures actual identity, not artificial drift; a per-arm noise floor comes for free.
