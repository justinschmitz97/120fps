import { DEFAULT_THRESHOLDS } from "../report/index.js";

export function helpText(): string {
  return `Usage: 120fps <component.tsx>[#ExportName] [more.tsx ...] [options]

Options:
  --explain-props                Dry run: print the resolved component and prop schema, measure nothing
  --fixture <path>               Fixture file for composed component measurement
  --json <path>                  JSON output path (default: 120fps-report.json)
  --ci                           CI mode: JSON-only output, exit 1 on fail
  --samples <n>                  Sample count per measurement (default: 10)
  --max-combos <n>               Prop combos to measure (default: 8)
  --explore-budget <seconds>     Total interaction exploration budget (default: 300)
  --init-fixture                 Write a starter fixture when auto-composition is rolled back
  --scale <n,n,...>              Scale points, overriding both defaults: combo-mode scale probes
                                 (default: 1,5,20,50) and curve-mode points (default: 1,3,5,10,20,50)
  --no-deltas                    Skip pairwise prop delta analysis
  --no-auto-scale                Disable auto-scaling prop detection
  --no-attribution               Disable cost attribution analysis
  --no-auto-compose              Disable auto-composition inference
  --no-react-analysis            Disable React optimization detection
  --framework <react|vue|vanilla|auto>  Framework detection mode (default: auto)
  --flat-thresholds              Disable tiered budgets, use flat thresholds
  --curve [prop:type]             Enable curve mode (auto-detect or specify prop:array|number)
  --no-curve                     Disable auto-activation of curve mode
  --matrix                       Enable prop variation matrix mode
  --no-matrix                    Disable auto-activation of matrix mode
  --save-baseline                Save current measurements as baseline
  --check                        Compare against baseline, fail on regression
  --budget                       Shorthand for --ci --check
  --no-baseline                  Skip baseline comparison in CI mode
  --no-cache                     Measure even when an unchanged component could reuse its baseline verdict
  --baseline-env <mode>          Baseline environment handling: strict|normalize|ignore (default: normalize)
  --isolate <phases>             Isolated measurement: mount,rerender,unmount,memory,strictmode,all
  --memory-cycles <n>            Mount/unmount cycles for memory mode (default: 20)
  --no-isolate                   Disable isolation mode (overrides --isolate)
  --wrap <path>                  Provider wrapper module (auto: 120fps.setup.tsx at project root)
  --no-wrap                      Disable the provider wrapper, including auto-detection
  --css <path,...>               Global stylesheets to inject (auto: app/globals.css and friends)
  --no-css                       Disable stylesheet injection, including auto-detection
  --react-compiler               Force the React Compiler transform on (auto: babel-plugin-react-compiler in package.json)
  --no-react-compiler            Disable the React Compiler transform, including auto-detection
  --no-shims                     Disable Next.js module shims
  --no-preflight                 Attempt the run even when the component graph reaches a server boundary
  --no-transforms                Do not load the project's own Vite transforms (SVGR, vanilla-extract)
  --compare <gitref>             Measure the working tree against <gitref>, samples interleaved (informational)
  --report-md <path>             Write a markdown summary (GitHub step summary / PR comment body)
  --report-junit <path>          Write JUnit XML, one testcase per component
  --threshold-mount <ms>         Mount time threshold (default: ${DEFAULT_THRESHOLDS.mountMs})
  --threshold-interaction <ms>   Interaction time threshold (default: ${DEFAULT_THRESHOLDS.interactionMs})
  --threshold-rerender <ms>      Rerender time threshold (default: ${DEFAULT_THRESHOLDS.rerenderMs})
  --help                         Show this help
  --version                      Print version

Exit codes:
  0   every measured component passed
  1   a verdict failed: over budget, or a regression under --check/--budget
  2   setup error: bad flag, missing file, harness or browser failure

Multiple components:
  Passing several paths, a directory, or a glob measures each in turn. With more
  than one component, --json becomes a filename template: <path>.<stem>.json per
  component, and the path you named is never written. The run prints the files it
  wrote. Components are measured in sorted path order, not argument order.

Named exports:
  Append #ExportName to a component path to measure that export instead of the
  one the resolver picks: 120fps ./kbd.tsx#KbdCombo. The name must be exported by
  the file; the error lists the file's component exports when it is not. A path
  whose own name contains # is left alone: only a trailing #Identifier after a
  .tsx/.jsx/.vue path is read as a target.

Combo caps:
  --max-combos bounds both prop-combo mode and matrix mode (default: 8 cells
  either way). In matrix mode, the base/anchor cell is always kept, then
  single-axis deviations from it, before wider cells are dropped.

Environment variables:
  The harness page only ever sees process.env from .env / .env.local files at
  the measured project's own root and its workspace root (read, never
  written); the invoking shell's environment is not passed through. Only keys
  prefixed NEXT_PUBLIC_ or VITE_ are forwarded, matching what a real Next.js
  or Vite build exposes to the browser. A component reading an unprefixed or
  shell-only variable measures undefined, same as it would in production.

Which mode answers which question:
  is it fast?                    (default)
  does it scale with its data?   --curve
  which prop costs the most?     --matrix
  is it leaking?                 --isolate memory
  did I regress?                 --budget
  did my change help?            --compare HEAD

All numbers are measured under 4x CPU throttle: comparative, not production wall-clock.
`;
}

export function printHelp(): void {
  process.stdout.write(helpText());
}
