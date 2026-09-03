---
kind: overview
status: approved
---

# Milestone summaries (M1–M106)

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
