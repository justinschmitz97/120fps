---
kind: overview
status: approved
---

# Milestone summaries (M1–M128)

One entry per milestone: about, why this way, achievement. One line each.

### M1: harness + prop extraction: done

- **About:** TS Compiler API prop extraction; Vite harness with Control API for mount/unmount/rerender.
- **Why this way:** bundler moduleResolution wins; React deduped via symlink; HOC/class unwrap; union cap 64; no user Vite config; no auto-mount.
- **Achievement:** props extracted and exercised behind one Control API.

### M2: mount/unmount measurement: done

- **About:** CDP trace per mount/unmount; 4x CPU throttle; 2 warmups; 10 samples; frame-driven.
- **Why this way:** trace wraps the action only; double-rAF fence; throttle only inside trace windows; frame pump fences at ~2ms, not 60Hz.
- **Achievement:** frame-precise mount/unmount timing with configurable throttle.

### M3: interaction discovery: done

- **About:** one page.evaluate DOM walk finds interactive elements and ARIA patterns in document order.
- **Why this way:** selector priority #id > data-testid > nth-of-type; opens shadow roots; skips hidden and aria-hidden.
- **Achievement:** deterministic inventory of interactive elements and roles.

### M4: exploration loop: done

- **About:** BFS state graph; state id = FNV-1a of #root innerHTML; limits 200 nodes, 60s, depth 4.
- **Why this way:** adaptive deepening on edge cost >1.5× median; stop after 10 zero-gain steps; seeded LCG; comboIndex guards misattachment.
- **Achievement:** systematic state-space exploration with transitions and perf variance.

### M5: CDP metric taxonomy: done

- **About:** single-pass trace parse; nesting stack for totalDuration; growth fits; INP, LayoutShift, heap delta.
- **Why this way:** nesting stack kills double-counting; fit needs ≥3 distinct n, R² > 0.5; calibration = DOM insert + offsetHeight; GC per sample.
- **Achievement:** categorized CDP metrics stable across Chromium versions.

### M6: CLI + reporting: done

- **About:** analyze() runs the pipeline; Report v1 JSON with threshold verdicts.
- **Why this way:** relativeMount = mount.median / calibration, threshold 2.0; zero calibration hard-fails; --ci JSON-only, exit 1/2; no config files.
- **Achievement:** one CLI run yields JSON verdicts.

### M7: composed fixtures: done

- **About:** *.fixture.tsx scenes mount with empty props; no 120fps imports.
- **Why this way:** adjacent fixtures auto-detected; throwing fixtures degrade; measured like auto combos.
- **Achievement:** fixtures measured uniformly beside extracted components.

### M8: rerender + parameterized scaling: done

- **About:** stable and prop-change rerender scenarios; scale(n) combos at [1, 5, 20, 50].
- **Why this way:** __120fps_scaleN marker prop; rerenderMs 16 at 4x throttle; curve needs ≥2 DOM sizes.
- **Achievement:** rerender cost at variable scale; dominant dimension identified.

### M9: portal discovery: done

- **About:** body walk beyond #root; aria-haspopup trigger probing; MutationObserver ≤2s for async portals.
- **Why this way:** probe only aria-haspopup triggers; 2 rAF for sync, observer for async; probe at initial state only.
- **Achievement:** sync, async, nested portals discovered and measured.

### M10: stress patterns: done

- **About:** exercise by type+role: keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, rapid-toggle-11; inside the trace per sample.
- **Why this way:** odd toggle count (11) exposes transitions; patterns traced every sample; single-shot fallback without ARIA.
- **Achievement:** realistic patterns expose cliffs single shots miss.

### M11: pairwise prop delta: done

- **About:** anchor combo, flip one prop, diff medians; cap 128 pairs; booleans > unions > objects.
- **Why this way:** reuse measured combos via JSON.stringify dedupe; skip function/reactnode/unknown; sort by |mountDelta|; --no-deltas.
- **Achievement:** per-prop cost isolated and ranked.

### M12: auto-scaling prop detection: done

- **About:** zero-config pick of one scalable prop (items arrays > numeric names); 5-point sweep.
- **Why this way:** manual scale() and fixtures win; disabled in fixtures; scaling is an extra pass, combos always run.
- **Achievement:** scaling without configuration.

### M13: tiered budgets: done

- **About:** tier from domNodeCount, portal, animation; tier budgets replace flat thresholds.
- **Why this way:** tier and flat budgets calibrated independently; explicit threshold overrides one metric only.
- **Achievement:** verdicts scale with component complexity.

### M14: animation detection: done

- **About:** getAnimations(), computed animationName, allowlisted transitions within #root.
- **Why this way:** first sample only (structural); no extra browser cycle; #root scope excludes Vite overlay and portals.
- **Achievement:** automatic animation-aware tiering; M64 narrowed to observed-only.

### M15: pointer-drag stress: done

- **About:** 60 linear pointermoves across the bounding box; axis per aria-orientation.
- **Why this way:** target priority slider > input[type=range] > aria-valuenow > cursor; rejects draggable, touch, scroll.
- **Achievement:** slider and range drag cost measured.

### M16: cost attribution: done

- **About:** mount scripting time split by source (npm, React, user, browser, unattributed) from stack URLs.
- **Why this way:** pure post-processing on existing traces; handles Vite URL munging; no source maps.
- **Achievement:** expensive dependencies named.

### M17: auto-composition: done

- **About:** infer flat/list/item/portal from multi-export names via suffix taxonomy.
- **Why this way:** root = shortest export prefixing all others; suffixes (Item, Trigger, Content) from Radix/shadcn.
- **Achievement:** multi-export combos without fixtures.

### M18: React optimization detection: done

- **About:** fiber walk detects bailouts, missed memos, re-renders, context fan-out, callback churn.
- **Why this way:** separate browser and probe entry; memos cloned on bailout; __120fpsStable context boundary; scaffolding filtered by name.
- **Achievement:** React findings delivered post-pipeline, separate from measurements.

### M19: Next.js shims: done

- **About:** self-contained shims for next/image, dynamic, link, navigation, headers, next-video.
- **Why this way:** keep DOM shape and prop forwarding, drop the asset pipeline; tsconfig aliases first; gated on hasNextJs.
- **Achievement:** Next.js components profiled without Next.js.

### M20: curve mode: done

- **About:** multi-axis sweep at [1, 3, 5, 10, 20, 50] for regression fitting.
- **Why this way:** auto-activates on detectScalingProps; every dimension per point; FAIL on super-linear growth or budget breach.
- **Achievement:** high-resolution scaling regressions caught.

### M21: matrix mode: done

- **About:** cartesian variant matrix (auto ≤64, cap 256 via all-pairs) for compound prop effects.
- **Why this way:** cells are combos, the matrix a projection; explore 5 hottest; print hot + failing.
- **Achievement:** compound effects invisible to single-prop deltas measured.

### M22: budget CI: done

- **About:** per-component budgets in 120fps.config.json; baseline in 120fps-baseline.json.
- **Why this way:** precedence CLI > per-component > defaults > TIER_BUDGETS; tolerances 10/15/15/20%; merge-writes; commit to git.
- **Achievement:** CI regression detection from versioned budgets.

### M23: isolated measurements: approved

- **About:** mount, rerender, unmount, memory, strict-mode phases in isolation; calibrated leak and churn thresholds.
- **Why this way:** StrictMode inside the wrapper; CDP GC (no page gc()); one browser per phase avoids JIT reuse.
- **Achievement:** leaks (8KB/cycle), churn (>2.0), double-invoke (<110%) detected per phase.

### M24: debt remediation (2026-07 audit): approved

- **About:** tsconfig parsing, export ordering, baseline paths, stale dirs, multi-path CLI, page-error enrichment.
- **Why this way:** each fix anchored to an observed failure; parseJsonConfigFileContent; file-ancestor walk; Chromium concurrency cap.
- **Achievement:** baseline paths resolve; exports deterministic; timeouts name page exceptions; rapid-toggle handles binary state.

### M25: stylesheet injection: approved

- **About:** global CSS from 8 fixed paths; --css overrides cascade; fonts settled before throttle.
- **Why this way:** CSS imports at entry top; wrapper CSS after the --css block; window.__120fps presence confirms styles loaded.
- **Achievement:** styled measurement in app cascade order.

### M26: provider wrapper: approved

- **About:** --wrap or auto-detected 120fps.setup.* wraps the component with providers.
- **Why this way:** ESM import order runs side effects first; mount includes provider cost; overhead traced separately.
- **Achievement:** providers measured; viewport export; wrapper CSS isolated from Node.

### M27: React Compiler awareness: approved

- **About:** detect babel-plugin-react-compiler; profile with the project's own version; drop pessimistic double-invoke warnings.
- **Why this way:** compiler from project node_modules; server-wide transform; compiler-runtime pre-bundled.
- **Achievement:** production compiler memoization recognized.

### M28: isolation execution: approved

- **About:** per-phase isolated passes; warmup 3; one browser per pass.
- **Why this way:** one pass serves mount + unmount; isolation in the fingerprint; jsx-runtime pre-declared.
- **Achievement:** isolated phases share setup; no mid-sample cold optimization.

### M29: baseline env fingerprint: approved

- **About:** fingerprint css, wrapper, compiler, throttle, calibration; classify unknown/incompatible/identical/normalizable.
- **Why this way:** fingerprint per entry; normalizable divides by own calibration; incompatible skips comparison.
- **Achievement:** honest baselines; pre-M29 entries marked unknown.

### M30: dogfooding remediation: approved

- **About:** 0.2.1 fixes across 6 repos: config isolation, template synthesis, composition validation, explore budgets, context-loss recovery.
- **Why this way:** configFile:false; trial-mount before calibration; explore cap stops >35min runs; one retry on a fresh session.
- **Achievement:** 27-combo runs in ~20min; context loss recovers.

### M31: measurement semantics: approved

- **About:** domNodeCount excludes harness chrome; combo cap 8 with representative selection.
- **Why this way:** 8 chrome nodes shifted every tier; silent cap 16 caused >35min runs; stratified sample beats prefix.
- **Achievement:** accurate tiers (≤10 T1, ≤40 T2, >40 T4); metrics version bump avoids false regressions.

### M32: developer experience: approved

- **About:** directory/glob expansion; fixture scaffolding; mode in table; explore-budget flag; distinct JSON names.
- **Why this way:** PowerShell lacks glob expansion; users need a scaffold; modes were unlabeled; explore options lacked CLI.
- **Achievement:** four workflow frictions removed.

### M33: frame-derived interaction budgets: approved

- **About:** per-event budgets 33/50/67/100ms for T1–T4 at 4x; pointer-drag = 60 events; CDP session replaced on context loss.
- **Why this way:** 8.33ms frame × 4 = 33ms; other tiers from 60fps + headroom; replacement avoids the Tracing.start error.
- **Achievement:** principled budgets; fair drag comparison; no session wedge.

### M34: profiler overhead reduction: done

- **About:** bookkeeping was ~60% of run time; GC, DOM reads, trace flush ran per sample.
- **Why this way:** suspend throttle for GC/DOM reads/unmounts; per-combo DOM info; cache the Vite deps union; no file watching.
- **Achievement:** faster runs; metrics unchanged within noise.

### M35: vsync-free lifecycle measurement: done

- **About:** double-rAF fence idled ~33ms per sample; ~80s vsync idle on badge.tsx vs ~5–10ms work.
- **Why this way:** --enable-begin-frame-control + HeadlessExperimental.beginFrame drives frames on demand (~1.9ms per fence).
- **Achievement:** vsync idle gone; animated combos fall back to real vsync.

### M36: shared prop-extraction program: done

- **About:** extractProps rebuilt ts.Program per call (~0.5–1s on Next.js repos).
- **Why this way:** memoizing CompilerHost keyed by (fileName, mtime, size); oldProgram retained per options key.
- **Achievement:** parsed graph shared across calls.

### M37: browser pool across phases and components: done

- **About:** each phase launched Chromium (~0.4–1s); sweeps paid hundreds.
- **Why this way:** BrowserPool holds ≤2 processes (driven + vsync); fresh context = renderer isolation.
- **Achievement:** launches pooled; fresh page per session.

### M38: cross-component sweep server: done

- **About:** each component booted Vite (~3–5s); one server can serve all harness dirs.
- **Why this way:** ServerPool keyed by (projectRoot, cssFiles, wrapPath, compiler, noShims); optimizeDeps frozen at first boot.
- **Achievement:** one server per multi-path run.

### M39: fingerprint-based baseline reuse: done

- **About:** unchanged components skip measurement; CI sweeps drop to seconds.
- **Why this way:** order-independent hash over sources, wrapper, stylesheets, configs, lockfile; requires sameMachineIdentity; calibration excluded.
- **Achievement:** cached CI verdicts.

### M40: measured-state integrity: implemented

- **About:** fetch-on-mount components measured their skeleton silently.
- **Why this way:** fetch/XHR wrap detects pending network; MutationObserver with 120ms grace after the fence; probes outside traced windows.
- **Achievement:** measuredState = settled/pending-network/late-mutation, with disclosure warning.

### M41: async wrapper setup: implemented

- **About:** request mocking needed before render; M26 excluded async setup.
- **Why this way:** optional setup(): void|Promise<void>, awaited once per session outside traces; 15s timeout.
- **Achievement:** pending components mockable and measurable.

### M42: server-only import preflight: implemented

- **About:** server-only imports failed minutes in as deep Vite errors.
- **Why this way:** AST import-graph walk after extraction, before boot; hard fail on server-only/use server/async export; warn on Node builtins.
- **Achievement:** unmountable components fail in seconds with the import chain.

### M43: scroll & wheel stress pattern: implemented

- **About:** scroll jank is the top complaint; M15 excluded scroll/wheel.
- **Why this way:** discover overflow containers with real overflow; 10 wheel ticks out and back; tick adapts to size.
- **Achievement:** virtualized and scrollable handler cost measured.

### M44: representative prop data (presets): implemented

- **About:** synthesized props made scenes unrepresentative (3 items, first union member, stub render props).
- **Why this way:** <stem>.props.tsx sidecar maps prop to value; literals from AST; functions/JSX as position markers.
- **Achievement:** real prop values without full fixtures, across all combo modes.

### M45: per-environment baselines & baseline workflow: implemented

- **About:** baselines keyed per environment slot; cross-env comparison an explicit fallback.
- **Why this way:** composite keys keep reader shapes, merge cleanly, sort by component.
- **Achievement:** CI and laptop slots separate; M39 reuse per slot.

### M46: noise sentinel: implemented

- **About:** run-level noise via probe CV and unstable-metric fraction.
- **Why this way:** thresholds from the existing 15% CV bar; probe = fixed arithmetic loop, not calibration.
- **Achievement:** noisy runs show regressions without failing; hostile runs skip comparison.

### M47: volatile DOM normalization: implemented

- **About:** timestamps and animations inflated the state graph.
- **Why this way:** structural addresses over object identity; tree-walk hash separates content from structure.
- **Achievement:** volatile content excluded; determinism across remounts.

### M48: load-bearing project transforms: implemented

- **About:** SVGR, vanilla-extract, preprocessors supported without loading vite.config.
- **Why this way:** detect from manifest; resolve from project node_modules; strip server hooks.
- **Achievement:** known transforms compile; unsupported ones get a code and diagnosis.

### M49: compare mode (interleaved A/B): implemented

- **About:** working tree vs git refs interleaved in one thermal window.
- **Why this way:** per-combo interleaving on the pooled browser; lockfile match enforced; node_modules linked into the worktree.
- **Achievement:** sample-range comparison; distinguishability via non-overlapping spreads.

### M50: CI surfacing: implemented

- **About:** GitHub markdown and JUnit output without forge APIs.
- **Why this way:** pure serializers over Report; no network; composes with every mode.
- **Achievement:** PR comments and CI rendering with noise and cache labels.

### M51: report actionability: implemented

- **About:** 10 finding classes map to 2–3 line hints with README anchors.
- **Why this way:** imperative verbs enforced; a test resolves anchors against headings; ids in Report, prose in README.
- **Achievement:** every run ends with actionable hints.

### M52: explore-phase observer rework: closed (premise falsified)

- **About:** assumed CDP tracing was the explore bottleneck; real cost is per-step settle under vsync.
- **Why this way:** measured first: trace = 4% of wall clock, not 91%; observer ratio 0.93 vs ≤0.50 target.
- **Achievement:** observers ship opt-in; trace path stays default.

### M53: statistical honesty: implemented

- **About:** P95/CV/fingerprint/churn/curve labels matched no computation; per-combo warmup added.
- **Why this way:** type-7 quantile (R/numpy); warmup ≤1 render; parity-split churn; raw-y curve ranking.
- **Achievement:** labels match the math; fingerprint records effective samples.

### M54: baseline reachability: implemented

- **About:** matrix/curve broke the baseline flow; --no-cache added; unreachable baselines warn.
- **Why this way:** mode is fingerprinted; disable flags had been over-excluded.
- **Achievement:** warn instead of silent skip; --curve --matrix errors.

### M55: ci-report mode coverage: implemented

- **About:** curve/isolation/cached CI output was placeholder dashes.
- **Why this way:** single reportMode dispatch; curve shows points and growth class; isolation shows phase medians.
- **Achievement:** meaningful markdown/JUnit per mode; warn verdict everywhere.

### M56: diagnostics & hygiene: implemented

- **About:** context-free errors; unbounded temp dirs; test script ≠ CI; retry exhaustion undefined.
- **Why this way:** age-based temp sweep needs no locks; npm test = CI suite; existing error types reused.
- **Achievement:** errors name remediation; disk leaks stopped.

### M57: Vue support: approved

- **About:** framework-neutral guarantees extended to Vue; harness, entry, extraction were React-only.
- **Why this way:** project's own SFC compiler; virtual script for props; entry and harness reused; no Vue deps shipped.
- **Achievement:** npx 120fps ./Button.vue yields the same schema, report, budgets, slots as React.

### M58: prop extraction binds to the target component: implemented

- **About:** first matching declaration won; six dogfooded components measured wrong props.
- **Why this way:** collect candidates; select by default export > stem match > source order; unwrap wrappers; self-consistency guard.
- **Achievement:** props resolve to the rendered component; helpers never shadow exports.

### M59: render-health gate & always-on page-error surfacing: implemented

- **About:** broken components passed with empty trees; page.goto failures lacked context.
- **Why this way:** page errors drained per combo; fatal = pageerror, not console.error; renderHealth is a reason beside the verdict.
- **Achievement:** render errors fail with cause, phase, combo, component.

### M60: prop synthesis honesty: implemented

- **About:** cva, empty pools, tuples, nested objects, Map/Set, class instances, computed types synthesized wrong silently.
- **Why this way:** strip null/void; most-specific shape first; cycle-safe recursion with property cap; mark degenerate.
- **Achievement:** faithful synthesis or a warning pointing to stem.props.tsx.

### M61: scale-probe transparency + matrix combo cap: implemented

- **About:** probe combos mixed into curves; matrix ignored --max-combos; probe cost unbounded (46.9s).
- **Why this way:** probe N marked; curves fit probe-only or real-only; symmetric distance-from-anchor selection; cost gate.
- **Achievement:** probes disclosed; one curve per mechanism; matrix bounded.

### M62: Next.js shim-usage reporting: implemented

- **About:** activeShims always undefined; shim alias matched before the external-dep scan.
- **Why this way:** tag shim aliases apart from tsconfig paths; report bare specifiers hitting shims; keep precedence.
- **Achievement:** shim usage reported; tsconfig aliases never reported as shims.

### M63: curve-fit stability & curve diagnostics: implemented

- **About:** classification flipped between runs; failures unnamed; --curve silent without an array prop; sub-linear called exponential.
- **Why this way:** growth exponent ≥1 magnitude gate; 50% residual-share fit gate; violations returned as data.
- **Achievement:** stable classification; failures name metric, budget, crossing N.

### M64: verdict & report clarity: implemented

- **About:** eight untrue report statements (2026-08-18 dogfood): delta sign, WARN under PASS, phantom baseline, style-inferred animation, exit codes.
- **Why this way:** warnings enriched at render; mode optional; animation observed-only; tier floor max(sizeTier, T3); page rules unit-testable.
- **Achievement:** report matches the run; names resolve through memo/forwardRef; --help documents exit codes.

### M65: DX features: implemented

- **About:** no prop preview; silent runs looked hung; provider throws blamed the component; stem rule inconsistent; some exports unreachable.
- **Why this way:** --explain-props reuses analyze's resolution; timer-free phase heartbeat; provider candidates on errors; #Export split.
- **Achievement:** dry-run props, heartbeat, provider hints, #Export targeting, unified stem rule.

### M66: attribution honesty: implemented

- **About:** breakdown summed all mounts against a median column; callback identity showed impossible drift.
- **Why this way:** per-sample mean over nested windows; stable arm uses cached callbacks; noise floor from arm spread.
- **Achievement:** one-mount average with sampleCount; true identity measurement.

### M67: CLI and attribution path correctness: implemented

- **About:** rooted globs matched nothing; case-insensitive FS overwrote same-named reports; pnpm paths attributed to ".pnpm".
- **Why this way:** glob tested in the pattern's own frame; case-fold the collision key only; lastIndexOf on node_modules/.
- **Achievement:** globs match; Card.tsx and card.tsx coexist; pnpm attributes to pkg. 9 tests.

### M68: workspace-aware project model: implemented

- **About:** nearest package.json answered every project question; workspace members lost plugins, Tailwind, compiler, invalidation.
- **Why this way:** memberRoot + workspaceRoot (bounded at .git); directory probe, not createRequire (NODE_PATH lies in tests); compiler declaration-only.
- **Achievement:** root-manifest detection for members; --compare links every level; single-package unchanged. 85 tests.

### M69: unified config resolution and import-scanner hardening: implemented

- **About:** alias and extraction picked different tsconfigs; scanner missed import(), require(), query suffixes, .json/.cjs, directory imports.
- **Why this way:** findCompilerConfig is the one upward walk; wildcard mismatch warns instead of an inert regex; stale target warns.
- **Achievement:** baseUrl bare imports resolve; dynamic and directory imports followed; allowJs fallback. 59 tests.

### M70: failure diagnosability plumbing: implemented

- **About:** CSS 404/500 became a blank 30s timeout; settleStyles result dropped; killed --compare left stale worktrees.
- **Why this way:** requestfailed and ≥400 listeners feed existing buckets; shared reportFontSettle; git worktree prune before add.
- **Achievement:** timeouts name the failing URL; one font warning per phase; stale worktrees pruned. 19 tests.

### M71: evidence-driven CSS discovery and vite.config data recovery: implemented

- **About:** eight-path allowlist missed src/style.css, .scss, entry-imported CSS; vite.config never read; process.env threw.
- **Why this way:** layers --css > entry graph > candidates > largest (warned); config parsed as text, never run; only NEXT_PUBLIC_/VITE_ env keys.
- **Achievement:** create-vite and Next.js CSS resolve; publicDir and literal aliases reach createServer. 102 tests.

### M72: unsupported-setup detection and clear rejections: implemented

- **About:** Solid, Preact-aliased, Yarn PnP, old Node, missing providers failed with confusing errors.
- **Why this way:** checks key on isPackageDeclared; react-dom identity from manifest name, not folder name.
- **Achievement:** named rejections: unsupported-framework, yarn-pnp; Node <22 exits 2. 33 tests.

### M73: harness boot guardrails and Next.js shim coverage: implemented

- **About:** read-only root, React 17, cross-drive --wrap, four unshimmed next/* modules failed as someone else's error.
- **Why this way:** W_OK preflight + wrapped mkdtempSync; isOutsideRoot cross-drive predicate; next/font/google never shimmed.
- **Achievement:** named failures before Vite boots; ten shims; unshimmed next/* warns. 42 tests.

### M74: environment advisories and font-load diagnostics: implemented

- **About:** plain Preact silent; failed webfonts settled silently; reports written without gitignore awareness.
- **Why this way:** PREACT_UNSUPPORTED_WARNING without rejection; settleStyles returns failedFamilies in one evaluate; literal gitignore matcher.
- **Achievement:** Preact warns; FONT_LOAD_FAILED_WARNING; GITIGNORE_ADVISORY_HINT. 30 tests.

### M75: import diagnosis and availability coverage: implemented

- **About:** .wasm/.glsl imports named only the importer; availability probe stopped at workspaceRoot; three repo shapes lacked fixtures.
- **Why this way:** wasm/shader recognizers in the transforms bucket; probe walks to the filesystem root; isPackageDeclared unchanged.
- **Achievement:** plugin-naming warnings; packages above workspaceRoot available; solid/preact/jsconfig fixtures. 26 tests.

### M76: layered alias resolution across the workspace: implemented

- **About:** tsconfig paths, vite aliases, wrappers, scanner collapsing read only the member package (mantine, chakra-ui, cal.com).
- **Why this way:** nearest-wins unchanged; workspace root as an additive, disclosed second layer; realpath containment over pnpm-workspace.yaml.
- **Achievement:** workspace-root fallbacks with dedicated warnings; sibling subpaths resolve.

### M77: type-space is not runtime-space: implemented

- **About:** TypeScript-resolved paths treated as loadable; @types/react alias and csstype crashed esbuild; .js JSX and .ts components rejected.
- **Why this way:** resolveTarget loadable-entry check gates aliases and optimizeDeps; wildcard paths exempt.
- **Achievement:** types-only aliases warn; type imports unscanned; .js/.ts components measured via hasComponentShape.

### M78: environment preflight tells the truth: implemented

- **About:** assertReactDomClient blamed "React too old" for four causes; --explain-props and --no-preflight skipped gates.
- **Why this way:** cause taxonomy: pnp, not-installed, not-declared, not-linked, outdated; real version checked first; --no-preflight cannot bypass.
- **Achievement:** real causes named; Preact aliases detected via resolveReactDomIdentity and BUNDLER_PREACT_ALIAS_WARNING.

### M79: diagnostics survive the failure path: implemented

- **About:** computed warnings discarded on crash; unhandled optimizeDeps rejection printed a raw stack at exit 1.
- **Why this way:** warnings attached to thrown errors; process-level handlers through formatCliError; unbuilt workspace vs broken dep by realpath.
- **Achievement:** crashes carry warnings and exit 2; unbuilt packages name their build step; curve shows [render error].

### M80: composition disclosure: implemented

- **About:** radix Roots mounted without siblings; PrimeVue DataTable mounted with 0 of ~69 props; both printed PASS.
- **Why this way:** declaredCompositionSiblings reads the file's own declarations; pass downgrades to WARN; findRoot fix deferred.
- **Achievement:** disclosureReason uncomposed/propsExcluded downgrades a pass; propsExcluded unproven end to end.

### M81: prop schemas are complete and safe to render: implemented

- **About:** 32-prop cap dropped variant/size; noise filter erased onClick/children; degenerate props fabricated crashers; "test" as currency.
- **Why this way:** three-tier rank; aria-/data- hard-filtered only; degenerate resolves to undefined; narrow currencyCode/locale allowlist.
- **Achievement:** variant props survive; Iterable and render degrade safely; ant-design onClick still past the cap (M86).

### M82: stylesheet selection is validated and disclosed: implemented

- **About:** largest-stylesheet fallback injected opt-in resets and 67-byte placeholders silently; report.css absent when empty.
- **Why this way:** stylesheetRuleCount and isOptInResetName on the fallback layer only; runtime engines checked last; fingerprints byte-identical.
- **Achievement:** report.css always carries layer; Stylesheets: line always prints.

### M83: modes and flags never lie about what ran: implemented

- **About:** domNodeCount 0 beside nonzero probes; "test" URL noise; hostile noise ignored by isolation FAIL; silent flag no-ops; leaked harness dirs.
- **Why this way:** inconsistency reported by combo index; harness noise filtered by URL shape; only hostile suppresses FAIL; no-ops warn.
- **Achievement:** four new warnings; hostile FAIL not forced; Linaria needs import-graph proof; exit sweep removes dirs.

### M84: synthesized prop values are semantically valid: implemented

- **About:** nested currencyCode "text"; image src "test" 404s; identity-keyed arrays threw; mixed unions dropped.
- **Why this way:** namedStringValue shared by classify and synthesize at any depth; exact names only; dedicated identity-collection pattern.
- **Achievement:** provenance on every value; data: URIs for src; real union members with disclosure.

### M85: a harness-caused failure is not the component's verdict: implemented

- **About:** synthesized asChild=true failed radix Separator; nested "text" currency crashed commerce.
- **Why this way:** generalizes isHarnessInternalNoise to renders; placeholder flagged only when its text appears in the error.
- **Achievement:** harnessFault demotes fail to warn; report.pass ignores faulted combos; preset hint.

### M86: prop selection keeps the props that matter: implemented

- **About:** cap dropped required config; inherited props buried onClick; preset naming a dropped prop rejected.
- **Why this way:** own-source-referenced props rank first; required props bypass the cap; generic-handler fallback unverified.
- **Achievement:** required, referenced, preset props survive; cap count stays true.

### M87: Vue scenes mount with their slots: implemented

- **About:** $slots.default() crashed; button.vue DOM=0 in combos vs 2/6/21/51 in the probe.
- **Why this way:** always pass a callable empty default slot; templateHasUnconditionalRoot gates the DOM wrapper.
- **Achievement:** slot calls survive; combo DOM matches probe; v-if roots untouched.

### M88: every run terminates and cleans up: implemented

- **About:** process.exit(2) skipped pool teardown; multi-component tail hung ~20min; dirs leaked on PASS and nested.
- **Why this way:** armExitWatchdog + closePoolsBounded with unref'd timers around Promise.allSettled teardown; nested case proven by test.
- **Achievement:** fatal exits within 10s; dirs removed on every path; uncaught exits 2; M101 extends to signals.

### M89: prop-delta measurement completes: implemented

- **About:** delta pass died on rAF starvation with no retry; tracing timeouts and closed targets unguarded; hint named unused --no-attribution.
- **Why this way:** bounded per-combo retry, degrade to a disclosed omission; one retry primitive around withContextRetry.
- **Achievement:** delta pass completes or names the combo; phase-aware hints; mount/explore stalls still say --no-attribution.

### M90: disclosure survives the failure path: implemented

- **About:** Stylesheets: line died with the run; pre-failure warnings block missed non-Error throws and async rejections.
- **Why this way:** stylesheet decision recorded as a warning when made; unconditional folding; module-level accumulator for resolveFatalProcessError.
- **Achievement:** warnings block at every throw site; Stylesheets: printed once.

### M91: modes and flags disclose identically: implemented

- **About:** --explain-props hid warnings; matrix dropped [props excluded]; async child one hop away died as __dirname.
- **Why this way:** explainProps runs the same probes in the same order; RSC gate reuses runPreflight per JSX-composed import.
- **Achievement:** identical warning sets; matrix carries disclosureReason; one-hop RSC gated.

### M92: every printed message is true of the run: implemented

- **About:** audit found false messages: unchecked composition claims, resolvable files called unresolvable, ADR 0002 exclusion hidden, no tsconfig cause.
- **Why this way:** predicates fixed at source, not reworded; hits scoped to the component entry; "import graph reaches X".
- **Achievement:** messages state only what predicates proved; PresetRef leak prints [preset value].

### M93: path aliases resolve every shape TypeScript accepts: implemented

- **About:** only trailing /* handled; mantine's mid-path and MUI's suffixed wildcards discarded; call-expression vite aliases unparsed.
- **Why this way:** buildWildcardCaptureAlias splits on the single * into RegExp/$1; warning text from actual counts.
- **Achievement:** mid-path wildcards resolve; @mantine/hooks no longer type-only; resolve()/join() aliases parsed.

### M94: bundler failures surface as 120fps errors: implemented

- **About:** Vite/PostCSS/esbuild dumped raw frames with 120fps node_modules paths; an "excluded" import still crashed.
- **Why this way:** stripBundlerStackFrames unconditional; diagnoseBundlerFailure names target, importer, remedy; unbuilt siblings aliased to src.
- **Achievement:** no node_modules paths in errors; UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING.

### M95: missing build output degrades, or names its command: implemented

- **About:** broken tsconfig extends, Nuxt #build modules, gitignored version.ts, unreadable Tailwind v4 CSS all crashed.
- **Why this way:** degrade where possible, fail fast with the command otherwise; TS codes 5083/6053, not 18003.
- **Achievement:** extends names the missing path; generated imports name the script; CSS_UNREADABLE_DROPPED_WARNING retries unstyled.

### M96: bundled shims match their real module surface: implemented

- **About:** next-navigation shim lacked ReadonlyURLSearchParams; cal.com DatePicker failed at build.
- **Why this way:** every shim audited against its real API, not one export patched; missing exports caught at M94's layer.
- **Achievement:** shims gain ReadonlyURLSearchParams, permanentRedirect, draftMode, getImageProps; errors name public specifier and --no-shims.

### M97: JavaScript components resolve like TypeScript ones: implemented

- **About:** .js/.jsx with sibling .d.ts reported only ref/key; MUI Badge, Chip, Tabs, Autocomplete wrong.
- **Why this way:** looksLikePropsType rejects ref/key-only; sibling .d.ts via ts.resolveModuleName; ADR 0004 supersedes ADR 0002.
- **Achievement:** MUI Badge.js reports 16 props; untyped JS warns by name; TS unchanged.

### M98: Vue props extract from every SFC shape the compiler accepts: implemented

- **About:** companion <script lang="ts"> props ignored (122/124 nuxt-ui); Options-API presets discarded (271/279 primevue).
- **Why this way:** both script blocks concatenated; unresolved defineProps<T> warns; presets append when extraction is empty.
- **Achievement:** nuxt-ui Badge 14 props, not 0; primevue presets as provenance: preset.

### M99: a page error belongs to the render that threw it: implemented

- **About:** rerender drain merged own render and next-combo transition; contract branch fired on truthy asChild alone.
- **Why this way:** two windows, pageErrors and transitionPageErrors, tagged [→ #N]; contract branch requires error-text evidence.
- **Achievement:** no borrowed errors; Chakra provider failures fail on their own terms.

### M100: the dry run and the real run share one static diagnosis: implemented

- **About:** --explain-props skipped seven static probes; mode prediction ignored precedence; composed runs skipped extraction.
- **Why this way:** one shared static pre-build probe; predictMode mirrors dispatcher order (isolation > curve > matrix > combo); runtime-only refusals listed.
- **Achievement:** dub dry run names the unbuilt alias; identical output with and without --framework; composed runs carry caveats.

### M101: a killed run leaves nothing behind: implemented

- **About:** no "exit" event on signals; harness dirs and Chromium/Vite children survived an hour; analyze() unbounded.
- **Why this way:** SIGINT/SIGTERM/SIGHUP teardown exits 128+signo; .pid markers refreshed per heartbeat; watchdog re-armed per phase.
- **Achievement:** taskkill'd dir swept within 1.5min by the next run; live-pid gate reads marker mtime.

### M102: stylesheet discovery reads the package's own declarations and discloses what applied: implemented

- **About:** heroui's stylesheet behind exports["./styles"] missed; shadcn's missing CSS crashed two ways; excalidraw's CSS matched nothing silently.
- **Why this way:** manifest style/exports outrank the size fallback; @import resolved one hop; missing nested imports dropped pre-bundler; match stats per sheet.
- **Achievement:** package-declared stylesheets; one warn-and-measure path; zero-match warning; mantine-F1 open by design.

### M103: the measured props are the component's own: implemented

- **About:** chakra Badge cap filled with <span> attributes; heroui bound the wrong export; min/max/step triggered curve mode.
- **Why this way:** 8-rank table by declaration origin and width; known variant-axis names promoted; one shared export order; bound names excluded.
- **Achievement:** colorPalette/variant/size in the window; correct binding; default column; class-typed props warn.

### M104: modes measure what they say they measure: implemented

- **About:** matrix header claimed uncrossed axes; probes counted as combos; curve skipped the React profiler; zero-DOM points fitted.
- **Why this way:** crossed vs held axes published; one combo count; shared React Optimizations renderer; zero-DOM points excluded; breadth-first cells.
- **Achievement:** honest headers and counts; curve prints attribution; all-empty curve fails with a hint.

### M105: every remedy names something that exists: implemented

- **About:** six remedies named wrong scripts, wrong package manager, self-advising flags, wrong labels, or nothing.
- **Why this way:** script lookup reads commands via the detected package manager; remedies drop once applied; findings labeled by kind.
- **Achievement:** npm run version; pnpm run build; yarn-pnp label; unbuilt dist/ disclosure; .env remedy; packageManager read at every level.

### M105 (Lane C): a Vue mount-phase abort reaches the hint pipeline: implemented

- **About:** $primevue and $slots.default() aborts printed bare stacks; hintsForReport needs a report that never existed.
- **Why this way:** new hints vuePluginGlobals (keyed on at Proxy.$ + undefined read) and vueSlotContent; unknown stacks get no guess.
- **Achievement:** hintsForMountAbort appends hints to the thrown error; names 120fps.setup.vue and <stem>.fixture.vue.

### M106: crashes and empty renders found only on the real corpus: implemented

- **About:** tracing timer armed too early; TDZ import cycle; sass globals dropped; curve pass over zero-node points; sprite refs rendered empty.
- **Why this way:** timer arms before the flush; explore inside the starvation retry; template globals folded; render health per curve point; sprite refs collected.
- **Achievement:** DatePicker reports in under a minute; import-cycle chain named; sass passes; empty curve fails; shell-injected ids warned.

### M107: workspace siblings resolve by their real entry: done

- **About:** directus and gutenberg aborted at exit 2 because a workspace sibling's `package.json` pointed at build output nobody had produced, and react-spectrum printed a warning asserting an unbuilt `dist/` that `@react-types/shared` never declared.
- **Why this way:** an unbuilt sibling is aliased to the source its own manifest points at, deriving candidates in the order `source`, the `exports` conditions `development`/`source`/`import`, `module`/`main` with the build-output segment dropped and a source extension applied, `types` beside a source file of the same stem, then `<pkg>/src`; every `exports` subpath key gets that same derivation; the walk continues from each aliased entry to a fixed point bounded by the workspace package count; a sibling declaring no runtime entry is disclosed as a types-only package; every message names the manifest field it followed, the path that field declared and whether the path exists on disk.
- **Achievement:** directus aliased eight siblings including two reached only through a rescued source, gutenberg aliased 23 where 8 were aliased before and named `build-module/index.mjs` with no `dist/` substring, react-spectrum's warning now reads "declares no runtime entry ... it ships declarations only, so it was left out of the pre-bundle and needs no build"; directus now stops one layer later, on the `.yaml` transform M108 and M110 own; gutenberg stops on an import clause spread over three lines that the scanner never read, which M110 closes.

### M108: a diagnosis names the layer that failed: done

- **About:** four repositories failed at exit 2 and were told the wrong cause: epic-stack's `#app` subpath import and primer-react's `react/compiler-runtime` both drew a Nuxt `nuxi prepare` remedy in repositories without Nuxt, hoppscotch's `~icons/lucide/eye` was blamed on an unbuilt workspace package, and documenso's Babel-macro failure ended with an env-file remedy.
- **Why this way:** a `#`-prefixed specifier resolves through the importer package's own `imports` field with the conditions Vite uses, and a specifier that map resolves is measured as a local import; the Nuxt diagnosis fires only for `#build`, `#imports` or `#app` in a repository that declares nuxt; the React Compiler transform emits only runtime imports that resolve for the installed React major and reports its target or its skip reason; a failure in a known virtual namespace names the plugin package the repository declares; a Babel-macro import is a `project-transform` preflight hit.
- **Achievement:** epic-stack reached `Result: PASS` at exit 0 in 68 s, primer-react ran the compiler at its installed React 18 and now fails on its own `__DEV__` global, hoppscotch's message names `unplugin-icons` as the owner of the `~icons/` namespace ahead of nine preflight warnings, and documenso leads with the captured throw beside a `@lingui/react/macro` transform warning and no env-file remedy; the `React Compiler: active (v1.0.0, target 18)` terminal line landed in lane C's follow-up.

### M109: the tsconfig is read the way TypeScript reads it: done

- **About:** four config shapes TypeScript understands ended a run before its first measurement: a references-only root such as the `create-vite` react-ts template writes, `"jsx": "preserve"`, a `paths` key mapping `"/*"`, and `customConditions`.
- **Why this way:** one reader answers which config governs a file and what that config says: a references-only nearest config delegates to the referenced config whose `include`/`files` covers the file, the first in the `references` array winning, while a cycle or a missing target ends the walk on the nearest config's options; `.ts`, `.tsx`, `.js` and `.jsx` compile with the automatic JSX runtime and the project's `jsxImportSource` whatever the config's `jsx` value is; a `paths` key with an empty non-wildcard prefix builds no alias and is registered once by key, target and declaring config; the real run and `--explain-props` call that one reader.
- **Achievement:** ark reached a verdict with `grep -c "React is not defined"` at 0, react-spectrum resolved through its referenced config's paths, the create-vite repro prints "tsconfig.json declares no compilerOptions and lists references; tsconfig.app.json covers src/components/Button.tsx and supplies paths, baseUrl" identically in the dry run and the real run, and ark's extraction reported `combos=8` from the tsconfig-governed program.

### M110: the dry run decides everything the real run decides from disk: done

- **About:** `--explain-props` predicted a mode the real run did not take on epic-stack, logto, supabase and calcom, and stayed silent about warnings the real run printed a minute later from the same files on disk.
- **Why this way:** the dry run decides auto-composition through the dispatcher's own gate and prints a `Composition:` line before the mode lines, and `matrixIneligibleReason` gained a `"composed"` case that explains why the matrix predicate lost; an explicit `--matrix` the dispatcher drops prints one warning naming what took precedence, in the real run and the dry run alike; the dry run pushes the project-transform warnings the real run pushes for the same filesystem inputs, through the one classifier lane A exports; an `optimizeDeps.include` candidate resolving to no installed directory, alias or `imports` entry is dropped from the include list and reported by specifier.
- **Achievement:** supabase's Popover dry run prints "would auto-compose from Popover (5 exports)" with the matrix line stating that a composed scene supplies the props, logto's dry run prints the same 13 `[transform:css-preprocessor]` lines its real run prints, calcom's dropped `--matrix` now names the auto-composed root and the `--no-auto-compose` remedy, and epic-stack's alias and unresolved-external parity run reached `Result: PASS`; the shadcn-admin control gained one line, `Composition:  would measure Button alone`, and no new warning.

### M111: a run works from any directory in the workspace: done (A2 matchedRules parity on midday deferred)

- **About:** midday's `packages/ui/src/components/button.tsx` reached calibration when the shell sat in `packages/ui` and crashed at exit 2 from the repository root, because Tailwind 3 read its config from `process.cwd()`.
- **Why this way:** a member whose PostCSS pipeline declares Tailwind 3 builds its CSS with the `tailwind.config.{js,cjs,mjs,ts}` nearest the member, searched from the member root through the workspace root, whatever directory the CLI started from; a member with no governing config gets a failure naming the filenames sought, the directories searched and the directory a run would have to start from, and that message never names a build script; every run prints the resolved member root and workspace root once; a script remedy prints the package manager invocation prefixed with `cd <dir> && ` when the package's directory differs from the start directory.
- **Achievement:** midday from the repository root reached exit 0 and `Result: PASS` after 160 s with `content option` and `border-border` at zero occurrences, and the member-root run produced the same `Stylesheets:` line, the same roots line and a `warnings` array equal by `JSON.stringify` between the two reports.

### M112: presets and remedies name real files: done

- **About:** five findings in which a printed remedy named a file the repository lacks or ignored one it has: radix-themes was told to add `button.props.tsx` beside a real `src/components/button.props.tsx` the run dropped in silence, its `--init-fixture` finished writing nothing, logto's cap warning asked for the preset the run had already applied, radix-themes reported a size-ranked fallback stylesheet while its `package.json` declared one, and epic-stack repeated the "add a preset" clause.
- **Why this way:** a preset is looked up under four candidate names in order and recognised by shape as a default-exported object literal, so an earlier candidate without that shape no longer stops the search; a candidate with the wrong shape is reported by its path and every remedy then names `<stem>.120fps.props.tsx`; the preset applies before any extraction warning prints, and the cap and collapsed-union warnings are re-rendered against the applied schema; `--init-fixture` on the never-composed path writes `<stem>.fixture.tsx` with one `TODO` per declared sibling or reports that the target exists; a package stylesheet declared in `package.json` whose target is missing is reported as declared-but-unbuilt with that package's build command, and the size-ranked fallback is suppressed for that run.
- **Achievement:** radix-themes discloses "src/components/button.props.tsx exists, not a preset: no default-exported object literal", its Dialog run wrote a 956-byte fixture scaffold and printed the edit-and-re-run line, its stylesheet line reads "package.json "style" declares styles.css, which is not built yet; run `pnpm run build` in that package", logto's cap warning names the applied preset as already loaded, and epic-stack's `app/components/ui/button.props.tsx` draws the same "exists, not a preset" disclosure radix-themes draws; every verdict stayed unchanged, and the shadcn-admin control's cap sentence stayed word for word, now printed in the run's warning block instead of on stderr.

### M113: every run leaves nothing behind, even on a signal: done

- **About:** base-ui's SIGTERM repro left `packages/react/.120fps-harness-lagPiI/` on disk and in `git status` 15 s after the kill, on one of two attempts, while Chromium and the Vite dev server were still live.
- **Why this way:** a run stopped by SIGINT, SIGTERM or SIGHUP exits with 130, 143 or 129 and removes its harness directories, and a second pass after the browser and dev server close catches a directory created after the pre-close pass; a busy or permission error is retried until it succeeds or 1 s per directory is spent over at least five attempts, and the post-close removal still returns inside 2 s, under the 8000 ms fatal-exit watchdog; a directory surviving the last attempt is printed once with its repository-relative path and its error code; the next run's `.pid`-marker sweep names each directory it removed and why, through the terminal, the `--json` warnings and the markdown report.
- **Achievement:** five of five signal attempts on Windows exited 143 with no `.120fps-harness-*` under the base-ui project root or `packages/react` and an empty `git status --porcelain`, a run to completion on the same root reached its report with no removal line, and a planted dead-pid directory in shadcn-admin drew "Removed a stale harness directory from an earlier run: .120fps-harness-planted (its owner process is gone)."

### M114: disclosures are true for runtime styling, props and page errors: done

- **About:** nine findings in which the run measured something defensible and then said something untrue about it: fluentui's Griffel component reported "no stylesheet found", its Dialog matrix crossed `open` with `defaultOpen`, gutenberg's and react-spectrum's barrels reported zero props, logto's wrapped default export made the header name and the props table disagree, ark's and vitesse's hints named a cause the run never read, React's `%s` reached supabase's reader raw, and vuetify was told it has no application entry while its vite config declares a root.
- **Why this way:** a package declaring a recognised runtime styling engine prints that no stylesheet was needed and names the engines, and an unrecognised `makeStyles`, `createUseStyles` or `styled` import is disclosed beside the `--css` remedy; a vite `root` or `build.rollupOptions.input` that folds statically resolves the entry, so the no-application-entry clause is claimed only when neither location holds one; console format specifiers are substituted from the console arguments before capture; a controlled prop and its `default` twin never share a matrix cell, and the axes held at one value are named; a re-export is followed to the declaring module and the measured file is disclosed beside the binding.
- **Achievement:** fluentui's line reads "styling is generated at runtime by @griffel/react, @griffel/core" and its Dialog matrix moved from `Result: FAIL` with 13 controlled-or-uncontrolled errors to `Result: PASS`, gutenberg and react-spectrum moved from `Props (0):` to `Props (32):` with a `re-export of` line naming the measured module, logto's header names `Button` with both exports listed, supabase's report holds zero `%s` occurrences, vuetify's false no-entry clause is gone twice over, and vitesse's mount abort ends with a `What to do about it:` block naming the undefined `defineModels` global.

### M115: every run prints where its minutes went: done

- **About:** a run reported one number, its own wall clock, so a maintainer working against the 283 logged runs of field-test run 5 (real-run median 39 s, max 251 s) had no phase to aim at and the performance work had no baseline.
- **Why this way:** a completed report carries `phaseTimings` with `preflight`, `build`, `calibration`, `mount`, `rerender`, `explore`, `scale`, `deltas`, `attribution`, `analysis` and `total`, every key present as an integer millisecond count and the ten phases summing to `total` exactly; each progress boundary line is classified by its label and a label matching none keeps the open phase, so the sum identity holds in combo, matrix, curve and isolation mode; the attribution window is subtracted from the phase it ran inside, so no millisecond is counted twice; each combo carries the explore wall clock the state graph already computed; the dry run prices the real run from the phases recorded for that component.
- **Achievement:** shadcn-admin's toolbar run wrote a JSON `phaseTimings` whose ten keys summed to 26036 against a `total` of 26036, within 1000 ms of its printed `Total: 26.0s`, with the verdict, the mode and all ten warnings identical to the pre-change run; the `Total:` line then gained the breakdown itself, `Total: 21.6s  (preflight 0s, build 1s, calibration 1s, mount 6s, rerender 5s, explore 7s, attribution 0s, analysis 2s)`; shadcn-admin's button dry run gained "Estimated real run: ~1m 31s (8 combos x 10 samples; defaults: no phase timings recorded for this component yet)" with every other line unchanged, and n8n's Button dry run reads the flags it was given: ~1m 3s for `--samples 5 --max-combos 4` against ~2m 9s without them.

### M116: explore replays and graph walks are paid for once: done (A/B evidence in the spec)

- **About:** explore replayed an edge's path from the root once per timing sample even for a pattern that provably ends where it started, and the import graph was parsed up to three times per run by `runPreflight` and walked twice more per build by `scanExternalDeps`, about 4N parses of the shared modules across a sweep of N components.
- **Why this way:** a state-invariant edge replays its path once before the first sample and runs samples 2..N from the state the previous sample left, with a replay forced after a frame-starvation or context retry and after a sample whose pattern skipped a planned step; a source file is read and parsed at most once per absolute path, `mtimeMs`, size and SFC-compiler flag, an edited file is re-read with no flag, and a compiler-bearing walk never reads a compiler-less parse of the same `.vue` file; `scanExternalDeps` writes the same values in the same order into every output channel it owns, cached or not; both lanes recorded an interleaved same-window A/B before approval, and a change showing no win or any difference in verdict, warnings or interaction rows would have been reverted.
- **Achievement:** the A/B pairs put explore 8.3 % lower on the scroll fixture (median 9316 ms to 8545 ms) while the control fixture without a state-invariant edge moved +0.1 %, and preflight 8.7 % lower on a seven-component sweep (1237 ms to 1129 ms) and 3.7 % lower on a single component, with identical verdicts, identical warning counts, identical interaction rows and edge medians inside the 15 % noise band.

### M117: output that respects the reader: done

- **About:** a run that rebuilt its harness printed the same static vite-config warning twice, that note named the key `plugins` and never the plugins it dropped, the noise line spent four sentences on a machine fact and named no flag, the `.gitignore` tip fired for a report written outside the repository, and the markdown report dropped the warnings the README promises.
- **Why this way:** a warning whose text repeats one already recorded for the same component report is recorded once and printed with the page-error ` (×N)` suffix, and the JSON holds one entry per distinct text in first-occurrence order; the markdown report carries one `<details>` fold per component that has warnings; the vite-config note names each declared plugin as the config writes it, in the config's own order, leaving out any plugin whose transform this run applied and disappearing when the list empties; the terminal noise line names only the signals that crossed their thresholds and the one flag that helps, while the JSON keeps the long sentences; the `.gitignore` tip prints once per process and only for paths inside the git root that the repository's `.gitignore` leaves uncovered.
- **Achievement:** shadcn-admin's Dialog run went from two "cannot honor" lines to one reading `tanstackRouter, react, tailwindcss` and from the four-sentence machine paragraph to "machine: hostile (probe CV 60%); raise --samples to measure through it." with the long form kept in the JSON, ark's note names `dts, react` once in the real run and once under `--explain-props`, shadcn-admin's toolbar tip narrowed to the single `.120fps-harness-*` pattern that applied, and every `Result:` line kept its wording.

### M118: the source tree says what each file is for: done

- **About:** `src/` was 26 flat files and 33,348 lines after M107-M117; `harness.ts` alone held 7,215 lines and 25 responsibilities, `analyze()` spanned 911 lines, one helper was written two or three times in different files, comments cited 1,250 milestone numbers, and `src/index.ts` re-exported about 470 names. Lane ownership by file serialised agents and each remediation landed in the nearest file.
- **Why this way:** ADR 0005 puts the code in nine stage directories (`cli`, `pipeline`, `analysis`, `report`, `browser`, `harness`, `props`, `project`, `shared`) with value imports pointing one way through stage `index.ts` files, one responsibility and at most 800 lines per file, one helper per fact in `shared/`, comments that state the invariant, and a curated root barrel. The refactor ran as pure `git mv` moves first (35 renames), then per-directory splits in parallel worktrees, then de-duplication, comment cleanup and surface curation, each step gated on `tsc` and the unit suite; two unit tests (`module-boundaries`, `module-ratchets`) enforce the layout with allowlists that shrank to empty. Behaviour stayed frozen: the same passing set before and after, byte-identical `--explain-props` output, and an independent adversarial review of the whole diff found no runtime-reachable change.
- **Achievement:** 116 files, largest 783 lines, zero boundary exceptions, zero history tokens in comments, zero duplicate function names, 12 runtime exports at the package root, unit suite `4803 passed | 1 skipped | 1 pre-existing failure` at 9ee7058, e2e `cli`, `shim-detect`, `baseline-env` 24 passed. Future milestone maps assign lanes by directory.

### M119: The harness loads the project's PostCSS config itself: done

- **About:** create-next-app's Tailwind 4 `plugins: ["@tailwindcss/postcss"]` and a Next.js `[name, options]` tuple like `postcss-preset-env` are shapes `postcss-load-config` does not accept, so Vite died at the first stylesheet request and the run ended as a harness-ready timeout; a workspace package that owns the config also owns the plugin dependency, so resolving it from the member root failed even when the shape was valid.
- **Why this way:** the harness finds the config the way Vite would (member root first, then upward), loads it itself, normalizes every entry shape (string, tuple, object-map with `false` entries disabled, instance, factory), resolves each named plugin with `createRequire` from the directory that actually declares it, and hands Vite `{ plugins, ...configOptions }` so `postcss-load-config` never runs; an unresolved plugin is dropped and named once, never replaced by a default, and the Tailwind 3 pipeline keeps precedence when it applies.
- **Spec:** `specs/milestones/m119-the-harness-loads-the-projects-postcss-config-itself.md`

### M120: A late `@import` still reaches the compiler: done

- **About:** a Tailwind 4 stylesheet with `@import 'tailwindcss'` on line 1, a few `@custom-variant` lines, then a second `@import` for its theme file loses that second import under Vite's vendored postcss-import, which deletes any `@import` that does not precede every other statement, so the theme's utilities become unknown classes and the stylesheet 500s.
- **Why this way:** before Vite's CSS plugin sees a `.css` module, the harness hoists a disallowed later `@import` to the end of the sheet's leading import block, preserving relative order, while `@charset`, a body-less `@layer`, comments and already-leading imports keep their place; only `@import` at brace depth zero counts, and a sheet whose imports already lead comes back unchanged with the plugin returning `null`.
- **Spec:** `specs/milestones/m120-a-late-css-import-still-reaches-the-compiler.md`

### M121: A stylesheet the app never loads does not end the run: done

- **About:** a guessed stylesheet used to cost the whole run when it was wrong: tooljet's pick was a Tailwind 4 sheet in a Tailwind 3 project, plane's was a fragment that only exists to be `@import`ed by the sheet the app really loads, and nuxt.com's never finished compiling — all three ended at an unexplained harness-ready timeout.
- **Why this way:** a candidate whose Tailwind dialect contradicts the installed Tailwind major is skipped before injection unless the project's own entry or manifest names it; after the dev server starts, each injected stylesheet is compiled once, bounded at 20 s, and a sheet that throws or "did not compile within 20 s" is dropped and reported, ending in the existing "the component may render unstyled" disclosure, with the entry rewritten and `cssFiles` updated so the run's own disclosure matches what was actually injected.
- **Spec:** `specs/milestones/m121-a-stylesheet-the-app-never-loads-does-not-end-the-run.md`

### M122: A sass import compiles, with a disclosed compiler: done

- **About:** Vite's own preprocessor loader has exactly two search bases (a `node_modules` walk-up from the CSS root, then one from Vite's own install) and no config lever; logto's `sass` existed only inside Vite's own pnpm store copy and vue-vben-admin's only inside an internal tooling package, neither on the measured app's own resolution chain, and the hit preflight already classified was only ever warned about, so both runs died 30 s later on Vite's raw `npm install -D sass-embedded` hint, naming the wrong package in the wrong package manager.
- **Why this way:** 120fps now declares `sass` as its own dependency so Vite's fallback base resolves it; when the project's own sass resolves on the member's or workspace root's chain nothing changes and nothing is disclosed, when neither does and 120fps's bundled sass does the run prints one disclosure, identical in the dry run and the real run, naming the importing file, its chain and the bundled version, and a `.less`/`.styl`/`.stylus` import whose implementation resolves from neither base is a hard preflight refusal naming the packages searched, the directories, and the member-scoped install command in the repository's own package manager.
- **Spec:** `specs/milestones/m122-a-sass-import-compiles-with-a-disclosed-compiler.md`

### M123: A Nuxt app is refused, or reaches the first measurement: done

- **About:** neither Nuxt app in the run-6 corpus reached a measurement, and neither said why: nocodb's tsconfig extends a `.nuxt/tsconfig.json` that `nuxi prepare` never finished writing, and esbuild's generic 500 could not match the existing Nuxt diagnosis; nuxt.com's `.nuxt/` was complete, and its run instead stalled on the largest-stylesheet fallback's Tailwind 4 sheet blocking the harness entry's whole module graph with an empty page-error capture at the readiness timeout.
- **Why this way:** a project that declares Nuxt or ships a `nuxt.config.*`, whose own tsconfig chain names a file under `.nuxt/` that is not on disk, is a hard preflight refusal identical in the dry run, naming the config, the missing file and the `nuxi prepare` remedy, while a project whose `.nuxt/` holds every file its tsconfig names is not refused; a readiness failure that captured no page error, in a run that injected a stylesheet, now names that stylesheet as a ranked suspect, never a verdict, and points at `--no-css`/`--css <file>` as the two commands that decide whether it is the cause.
- **Spec:** `specs/milestones/m123-a-nuxt-app-is-refused-or-reaches-the-first-measurement.md`

### M124: A Babel macro import is refused before the browser: done

- **About:** a `babel-macro` import (documenso's `@lingui/react/macro`) was already classified by preflight and printed as a warning, but `babel-macro` was never in the set of codes the promotion loop hardens into a refusal, so the run continued past a complete diagnosis into the browser and died on an unrelated-looking `Unable to determine current node version` — the macro's own module reaching the browser unexpanded, a run-5 finding reappearing one layer later.
- **Why this way:** a `project-transform` hit whose `transformCode` is `babel-macro` is now a hard preflight hit, refused before the browser with an identical message in the dry run, naming the importer, the macro specifier, the full chain and the declared macro compiler (or saying none is declared); the remedy is to write the macro call out by hand, measure a component whose graph does not reach it, or pass `--no-preflight`, which still runs the rest of the pipeline unchanged.
- **Spec:** `specs/milestones/m124-a-babel-macro-import-is-refused-before-the-browser.md`

### M125: the readiness wait says what it waited for and how long: done

- **About:** two run-6 lanes stopped at ~30 s with only "component harness did not become ready within timeout. No page errors were captured.", naming no global, no bound and no cause; the 30 s bound was a literal repeated at four call sites with no environment override, and nothing measured the wait.
- **Why this way:** `waitForReadyOrFatal` now owns one deadline, `FPS120_READY_TIMEOUT_MS` (default 90000 ms, one shared export), re-entering a wait that ended before the deadline unless it gave up in under 100 ms; the appended sentence names the global (`window.__120fps`), the measured seconds waited, the two usual causes as possibilities, and the environment variable, without naming a specific module or file the run did not itself observe; an invalid value keeps the default with a once-per-process disclosure.
- **Spec:** `specs/milestones/m125-the-readiness-wait-says-what-it-waited-for-and-how-long.md`

### M126: an exports subpath of an unbuilt sibling resolves to its source: done

- **About:** M107 rescues an unbuilt workspace sibling's root entry by deriving a source path beside its declared build output, but a package that builds flat into `dist/` from a nested `src/` tree keeps none of its subpaths rescued that way; twenty is that shape (15 of 20 export keys), and measuring a component that imports one of them stopped the run on an unaliased subpath.
- **Why this way:** a declared `exports` subpath whose target does not exist on disk now resolves to the sibling's own source using the same derivation the root entry uses (the declared path, that path with its leading segment dropped, and either under `src/`), is aliased and queued into the import walk so its own imports are scanned too, adding no new disclosure beyond the package's existing rescue warning; a subpath with no source candidate keeps today's dropped-and-warned behaviour, and no already-resolving layout changes.
- **Spec:** `specs/milestones/m126-an-exports-subpath-of-an-unbuilt-sibling-resolves-to-its-source.md`

### M127: a React Native app renders through react-native-web: done

- **About:** bluesky-social-app ships both `react-native` and `react-native-web` and aliases one to the other in its own webpack config, a substitution the harness made nowhere, so Vite's dependency optimizer pre-bundled `react-native` itself (a tsconfig `customConditions` value even selected a `.d.ts` entry for it) and the run ended in 147 raw esbuild errors with no diagnosis.
- **Why this way:** with `react-native` in the component's import graph and `react-native-web` resolvable, the harness aliases `react-native` to `react-native-web`, drops it from the pre-bundle list in favor of the alias, and discloses the substitution once; with no `react-native-web` installed, or with other packages in the graph that declare `react-native` as their own dependency and ship native-only code the substitution can't reach, the run stops naming React Native, the count of such modules and the importing file instead of surfacing esbuild's own output; a project with no `react-native` in its graph is unchanged.
- **Spec:** `specs/milestones/m127-a-react-native-app-renders-through-react-native-web.md`

### M128: the callback-identity pass measures each prop set once: done

- **About:** the callback-identity pass was 97% of the React analysis phase (62 s median at `--samples 3 --max-combos 2` across a 50-repo smoke pass) because it re-measured the same prop set up to four times — the explorer's scale probes all pass `{}` — and probed a capture-phase prop beside its bubble twin (`onCopyCapture` next to `onCopy`), two multipliers that carried no information.
- **Why this way:** the pass now runs at most once per distinct serialized prop set (counting a `__120fps_scaleN` trigger as absent), skips an `X + "Capture"` prop when `X` is already in the list, collects garbage once per probed prop instead of once per arm, and measures `renderAttribution` in its own reset-mount-rerender window so its `renderCount` and durations describe the component instead of the pass; `memoBailout`, `contextFanOut` and `portalOrphans` stay measured per combo index unchanged, and median analysis time fell about 77% on both profiled repos (ai-chatbot 62.8 s to 14.5 s, memos 64.0 s to 15.3 s).
- **Spec:** `specs/milestones/m128-the-callback-identity-pass-measures-each-prop-set-once.md`

### M129: a fatal before readiness ends the run at once, with the bound it advertises: done

- **About:** four run-7 repositories waited the full 90-100 s readiness bound after failing in the first few seconds: a captured fatal was read only after the deadline expired, a same-origin module server error never armed a fatal at all, a bundler diagnosis replaced the readiness report instead of appending to it, three of four navigations carried no timeout of their own, and a stale-but-installed preprocessor or an unshimmable `next/font/google` import produced no diagnosis, or a dry-run/real-run disagreement.
- **Why this way:** `waitForReadyOrFatal` now consults an already-captured fatal on entry; a same-origin 500 on a URL requested as a module arms the wait's fatal; a bundler diagnosis is appended below the readiness sentence, never substituted for it; every `page.goto` carries the readiness bound; a stale preprocessor API mismatch and an unshimmable `next/*` module each become a named diagnosis instead of a timeout or a soft warning. taxonomy 93 s to 4 s, directus 94 s to 10 s, twenty 97 s to 25 s, n8n 100 s to 25 s.
- **Spec:** `specs/milestones/m129-a-fatal-before-readiness-ends-the-run-at-once.md`

### M130: an unbuilt workspace sibling is walked, typed and aliased as its own package: done

- **About:** the dependency scan, the preflight walk and the compiler options answered "does this workspace sibling's build output exist" three different ways: the preflight walk stopped at every `node_modules`-resolved edge, so an import crossing a symlinked sibling boundary was never gated; an unbuilt sibling's own types never resolved, so a required prop went unnoticed; and one alias table applied to every file in a monorepo produced 149 false stale-alias warnings on a single repository.
- **Why this way:** the preflight walk now crosses into a sibling's derived source entry the same way the dependency scan already does, so a `.yaml`-shaped hit behind it is caught; `createCompilerOptions` injects a `paths` entry for each such sibling; an alias is resolved and memoized against the tsconfig that governs the file that wrote it, not the measured package's own table; and a stale alias inside the measured graph is a hard preflight refusal, collapsed to at most three named examples per pattern when it is only a warning. directus's `.yaml` edge is now a refusal before the browser in both modes; dub's `icon` prop is extracted and required; twenty's dry run drops from 149 stale-alias lines to zero.
- **Spec:** `specs/milestones/m130-an-unbuilt-workspace-sibling-is-walked-typed-and-aliased.md`

### M131: the stylesheet a typical app loads is found where the app loads it: done

- **About:** the entry-chain walk knew only an `index.html` module script and a Next.js entry stem, one hop shy of most of the corpus's real shapes, so most run-7 repositories that printed a stylesheet decision either found none or a size-ranked fallback; a package stylesheet resolved by an exact `exports` key only; and the injected-sheet disclosure buried three real misses inside eleven identically-worded feature-sheet lines.
- **Why this way:** the entry chain now follows RR7/Remix's `app/root.tsx`, a `nuxt.config`'s `css:` array, a `?url`-bound import, and one hop below the entry in source order; a bare package specifier resolves through a wildcard `exports` pattern before falling through to an on-disk probe; the ranked walk no longer stops at the first candidate it cannot preprocess; and the disclosure collapses sheets that matched nothing into one line while a genuinely wrong fallback pick gets its own line naming `--css`. M122's Sass disclosure now also covers a stylesheet reached this way.
- **Spec:** `specs/milestones/m131-the-stylesheet-a-typical-app-loads-is-found.md`

### M132: every warning on a typical run is true, printed once, and names what to do: done

- **About:** of the warnings a passing run prints, seven were wrong, repeated, or not the tool's to print: a component with no props was hedged as maybe a failed extraction, an honored Vite alias or a named plugin list was called ignored or anonymous, a project-level note printed three times in one dry run, Node's own `MODULE_TYPELESS_PACKAGE_JSON` warning about the project's own config file reached the terminal, `--no-css` was a no-op in the dry run, a provider hint named a hook the file never imported, a third party's stderr streamed raw and then the same fact was reported properly a hundred lines later, and one warning carried a doubled `⚠ Warning:` prefix.
- **Why this way:** the zero-prop warning states that the component declares none unless the run has an actual reason to suspect a failed extraction; the vite-config note names only what was actually dropped and is produced once per run, not once per candidate; a process-level warning listener swallows Node's own warning for a file outside 120fps's own install; `--no-css` and `--css` forward into the dry run exactly as they decide the real run; a provider hint names the hook the file actually imported, or the package alone when it did not; a third party's `console.error` output is captured and printed, attributed to its package, only when no 120fps warning already covers the same fact; and a text that already carries the warning prefix is never prefixed twice.
- **Spec:** `specs/milestones/m132-every-warning-on-a-typical-run-is-true-and-printed-once.md`

### M133: a render failure names its provider, its bad value, and nothing that never rendered: done

- **About:** three of six run-7 render failures printed a generic remedy although the page error and the component's own first import already named the missing provider; a growth hint was fitted over combos that never rendered; a string-typed dimension prop synthesized the placeholder `"test"`, rendering a malformed SVG on every sample, with the disclosure that would have named it gated off; a prop typed `React.ElementType` and extracted as required measured every combo as `undefined`; and the help text described exit 1 as over budget or a regression alone, which is not what a render crash is.
- **Why this way:** the provider-scope table covers `@mantine/`, `@chakra-ui/` and `@trpc/` beside `@radix-ui/`, and names the representative hook of `react-intl`, `jotai`/`jotai-scope` and the two `@trpc/*-query` packages; candidates are ranked by whether the captured page error's own words name them; no hint is derived from a combo whose `renderHealth` is `error`, in combo mode and curve mode alike; a dimension-named string prop synthesizes `"16"` with provenance `heuristic`, and a prop shaped `React.ElementType` synthesizes `"div"` the same way; a synthesized placeholder that still reaches the DOM is disclosed as `[harness fault]` without changing the verdict; and `--help` now names a render error as one of the reasons exit 1 happens.
- **Spec:** `specs/milestones/m133-a-render-failure-names-its-provider-and-its-bad-value.md`

### M134: the passing run pays for each distinct prop set once and labels its phases truthfully: done

- **About:** the React analysis pass re-measured four identical auto-scale prop sets from scratch, a scale-point gate threw away a full measurement it then repeated in the main batch, the "calibration" phase bucket was at least 97% something else, the memo pass mounted and rerendered trees with no memo fiber, and `--explore-budget` bounded nothing: a 30 s budget produced a 31.6 s single combo and curve mode read no budget at all.
- **Why this way:** the analysis pass measures each distinct `propCombinationKey` once and shares the result; the scale gate reads the main batch's own measurement instead of discarding one; a new `setup` phase absorbs the wrapper overhead, session close, schema extraction and combination planning that used to hide inside `calibration`; the memo pass runs only when a snapshot has an `isMemo` fiber; `--explore-budget` derives the per-combo and per-curve-point share of the phase budget and is checked before the first unit runs, with `observerTiming` threaded as an opt-in path. rallly's curve mode 205 s to 47 s, novu's explore phase 33 s to 18 s.
- **Spec:** `specs/milestones/m134-the-passing-run-pays-for-each-prop-set-once-and-labels-its-phases.md`

### M135: the dry run resolves each module and reads each tsconfig once: done

- **About:** 56% of a sampled posthog `--explain-props` CPU profile was spent in uncached module resolution and tsconfig parsing repeated across candidates, and every tsconfig parse expanded the project's `include` globs across the whole repository to build a file list only one predicate ever read.
- **Why this way:** a `ts.ModuleResolutionCache` scoped to the run and keyed by project root and compiler options serves every candidate; both tsconfig readers memoize by absolute config path and parse with a host whose `readDirectory` returns nothing, expanding `include` globs lazily only when `coversTarget` actually needs them; a specifier that resolves nowhere is disclosed once per run instead of once per candidate. posthog's three-candidate dry run falls from 316 s to 116 s with byte-identical output.
- **Spec:** `specs/milestones/m135-the-dry-run-resolves-each-module-and-reads-each-tsconfig-once.md`

### M136: a Vue app's generated auto-import maps resolve its components and composables: done

- **About:** of twelve Vue repositories inventoried, three fail with a `ReferenceError` for an auto-imported identifier the harness never registers, one fails on an unresolved Nuxt auto-component the log never names, one cannot compile a single-file component because the Vue plugin lives only under `.pnpm`, and one passes only by the accident of a hoisted transitive install.
- **Why this way:** the harness reads the project's own generated declaration files — `components.d.ts`, `.nuxt/components.d.ts`, `auto-imports.d.ts` — as a name-to-module table instead of executing the project's Vite config; the Vue plugin resolves through a host framework the project declares when the project itself does not; a components map registers entries that resolve inside the project's own source tree; an auto-import map prepends an import for a free identifier the measured component's own graph references. Stage 2 stopped and re-scoped after its own falsifier fired: a dependency-provided Nuxt component (`@nuxt/ui`'s `UCarousel`) needs the Nuxt app context (`#imports`) a bare `createApp` does not supply, so only a locally-defined component is registered, and a dependency's own component is named, not synthesized.
- **Spec:** `specs/milestones/m136-a-vue-apps-generated-auto-import-maps-resolve.md`

### M137: explore measures the component, not the browser it runs in: done

- **About:** two of eleven run-7 scaffolds failed their verdict on a component that never changed: create-vue and create-vite's Vue template ship a footer of external links, explore discovered and clicked them eleven times per sample, and the browser's own attempt to leave the page — 215-255 ms per step against a 33-100 ms budget — decided PASS or FAIL.
- **Why this way:** an anchor whose resolved origin differs from the page's, or that carries `target="_blank"`, `rel="external"` or a non-`http(s)` scheme, is not exercised, and the discovery line names how many targets were skipped and why; a click that nonetheless opens a popup or navigates away is closed, returned from, and recorded as skipped rather than measured. Withholding a FAIL on a noisy machine was evaluated and rejected: budget verdicts stay absolute.
- **Spec:** `specs/milestones/m137-explore-measures-the-component-not-the-browser-it-runs-in.md`

### M138: `--ci`, `--check` and `--save-baseline` say what they did and write where they are told: done

- **About:** every `--report-md` written in run 7 said `**PASS**: 0 components, 0 regressions` and every `--report-junit` said `tests="0"`, including runs that exited 1, because the array the writers read was never filled; a reused `--check` verdict printed a baseline comparison, an environment match and a fixture suggestion for a measurement that never happened and dropped every warning the original run produced; and `--save-baseline` could only write into the project root, the one flag built for repeatable runs dirtying the repository it measures.
- **Why this way:** every finished `Report` now reaches the CI writers, and a sweep that exits 1 with no failing component gains a synthetic `120fps run` JUnit testcase; a reused verdict prints one reuse sentence and nothing else, and replays the stored entry's own warnings, bounded and sanitized; a stored entry recorded under a different mode is named and re-measured rather than silently ignored; `--baseline-file <path>` names where `--save-baseline` writes and `--check` reads, refused up front for a sweep spanning multiple project roots.
- **Spec:** `specs/milestones/m138-ci-check-and-save-baseline-say-what-they-did.md`
