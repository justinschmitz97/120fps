#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { analyze } from "./analyze.js";
import { compareAgainstRef, formatCompare, validateCompareOptions } from "./compare.js";
import { formatMarkdown, formatJUnit } from "./ci-report.js";
import { createBrowserPool } from "./measure.js";
import { createServerPool } from "./harness.js";
import { parseIsolationPhases, strictModeUnsupported, VUE_STRICTMODE_ERROR } from "./isolation.js";
import { formatTable, DEFAULT_THRESHOLDS } from "./report.js";

const ISOLATE_USAGE_ERROR =
  "--isolate requires a comma-separated list of phases (mount,rerender,unmount,memory,strictmode,all)";

const SKIP_DIRS = ["node_modules", "dist", "build", ".next", ".120fps-harness-"];
const SKIP_SUFFIX = [".test.", ".spec.", ".stories.", ".fixture."];


export interface CliArgs {
  componentPath?: string;
  fixturePath?: string;
  jsonPath: string;
  ci: boolean;
  samples?: number;
  maxCombos?: number;
  initFixture?: boolean;
  exploreBudgetSeconds?: number;
  thresholdMount?: number;
  thresholdInteraction?: number;
  thresholdRerender?: number;
  scale?: number[];
  noDeltas?: boolean;
  noAutoScale?: boolean;
  noAttribution?: boolean;
  noAutoCompose?: boolean;
  noReactAnalysis?: boolean;
  framework?: "react" | "vue" | "vanilla" | "auto";
  flatThresholds?: boolean;
  noShims?: boolean;
  curve?: boolean | string;
  noCurve?: boolean;
  matrix?: boolean;
  noMatrix?: boolean;
  saveBaseline?: boolean;
  check?: boolean;
  budget?: boolean;
  noBaseline?: boolean;
  noCache?: boolean;
  noPreflight?: boolean;
  noTransforms?: boolean;
  compare?: string;
  reportMd?: string;
  reportJunit?: string;
  baselineEnv?: "strict" | "normalize" | "ignore";
  componentPaths?: string[];
  jsonExplicit?: boolean;
  isolate?: string[];
  memoryCycles?: number;
  noIsolate?: boolean;
  wrapPath?: string;
  noWrap?: boolean;
  css?: string[];
  noCss?: boolean;
  reactCompiler?: boolean;
  noReactCompiler?: boolean;
  help: boolean;
  version: boolean;
  error?: string;
}

export const KNOWN_FLAGS = new Set([
  "--json",
  "--ci",
  "--samples",
  "--max-combos",
  "--init-fixture",
  "--explore-budget",
  "--threshold-mount",
  "--threshold-interaction",
  "--threshold-rerender",
  "--scale",
  "--fixture",
  "--no-deltas",
  "--no-auto-scale",
  "--no-attribution",
  "--no-auto-compose",
  "--no-react-analysis",
  "--framework",
  "--flat-thresholds",
  "--no-shims",
  "--curve",
  "--no-curve",
  "--matrix",
  "--no-matrix",
  "--save-baseline",
  "--check",
  "--budget",
  "--no-baseline",
  "--no-cache",
  "--baseline-env",
  "--isolate",
  "--memory-cycles",
  "--no-isolate",
  "--wrap",
  "--no-wrap",
  "--css",
  "--no-css",
  "--react-compiler",
  "--no-react-compiler",
  "--no-preflight",
  "--no-transforms",
  "--compare",
  "--report-md",
  "--report-junit",
  "--help",
  "--version",
]);

export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    jsonPath: "120fps-report.json",
    ci: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help") {
      result.help = true;
      i++;
      continue;
    }
    if (arg === "--version") {
      result.version = true;
      i++;
      continue;
    }
    if (arg === "--ci") {
      result.ci = true;
      i++;
      continue;
    }
    if (arg === "--no-deltas") {
      result.noDeltas = true;
      i++;
      continue;
    }
    if (arg === "--no-auto-scale") {
      result.noAutoScale = true;
      i++;
      continue;
    }
    if (arg === "--no-attribution") {
      result.noAttribution = true;
      i++;
      continue;
    }
    if (arg === "--no-auto-compose") {
      result.noAutoCompose = true;
      i++;
      continue;
    }
    if (arg === "--no-react-analysis") {
      result.noReactAnalysis = true;
      i++;
      continue;
    }
    if (arg === "--framework") {
      if (i + 1 >= argv.length) {
        result.error = "--framework requires a value (react, vue, vanilla, or auto)";
        return result;
      }
      const val = argv[++i];
      if (val !== "react" && val !== "vue" && val !== "vanilla" && val !== "auto") {
        result.error = `--framework must be react, vue, vanilla, or auto, got "${val}"`;
        return result;
      }
      result.framework = val;
      i++;
      continue;
    }
    if (arg === "--flat-thresholds") {
      result.flatThresholds = true;
      i++;
      continue;
    }
    if (arg === "--no-shims") {
      result.noShims = true;
      i++;
      continue;
    }
    if (arg === "--curve") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && /^\w+:(array|number)$/.test(next)) {
        result.curve = next;
        i += 2;
      } else if (next && !next.startsWith("--") && /^\w+:\w+$/.test(next)) {
        result.error = `--curve prop:type must use type "array" or "number", got "${next}"`;
        return result;
      } else {
        result.curve = true;
        i++;
      }
      continue;
    }
    if (arg === "--no-curve") {
      result.noCurve = true;
      i++;
      continue;
    }
    if (arg === "--matrix") {
      result.matrix = true;
      i++;
      continue;
    }
    if (arg === "--no-matrix") {
      result.noMatrix = true;
      i++;
      continue;
    }
    if (arg === "--save-baseline") {
      result.saveBaseline = true;
      i++;
      continue;
    }
    if (arg === "--check") {
      result.check = true;
      i++;
      continue;
    }
    if (arg === "--budget") {
      result.budget = true;
      result.ci = true;
      result.check = true;
      i++;
      continue;
    }
    if (arg === "--no-cache") {
      result.noCache = true;
      i++;
      continue;
    }
    if (arg === "--no-baseline") {
      result.noBaseline = true;
      i++;
      continue;
    }
    if (arg === "--baseline-env") {
      if (i + 1 >= argv.length) {
        result.error = "--baseline-env requires a value (strict, normalize, or ignore)";
        return result;
      }
      const val = argv[++i];
      if (val !== "strict" && val !== "normalize" && val !== "ignore") {
        result.error = `--baseline-env must be strict, normalize, or ignore, got "${val}"`;
        return result;
      }
      result.baselineEnv = val;
      i++;
      continue;
    }
    if (arg === "--isolate") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        result.error = ISOLATE_USAGE_ERROR;
        return result;
      }
      let phases: string[];
      try {
        phases = parseIsolationPhases(argv[++i]);
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        return result;
      }
      if (phases.length === 0) {
        result.error = ISOLATE_USAGE_ERROR;
        return result;
      }
      result.isolate = phases;
      i++;
      continue;
    }
    if (arg === "--memory-cycles") {
      if (i + 1 >= argv.length) {
        result.error = "--memory-cycles requires a positive integer";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
        result.error = `--memory-cycles must be a positive integer, got "${argv[i]}"`;
        return result;
      }
      result.memoryCycles = n;
      i++;
      continue;
    }
    if (arg === "--no-isolate") {
      result.noIsolate = true;
      i++;
      continue;
    }
    if (arg === "--wrap") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        result.error = "--wrap requires a path argument";
        return result;
      }
      result.wrapPath = argv[++i];
      i++;
      continue;
    }
    if (arg === "--no-wrap") {
      result.noWrap = true;
      i++;
      continue;
    }
    if (arg === "--css") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        result.error = "--css requires a comma-separated list of stylesheet paths";
        return result;
      }
      const parts = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) {
        result.error = "--css requires at least one stylesheet path";
        return result;
      }
      result.css = parts;
      i++;
      continue;
    }
    if (arg === "--no-css") {
      result.noCss = true;
      i++;
      continue;
    }
    if (arg === "--react-compiler") {
      result.reactCompiler = true;
      i++;
      continue;
    }
    if (arg === "--no-react-compiler") {
      result.noReactCompiler = true;
      i++;
      continue;
    }
    if (arg === "--no-preflight") {
      result.noPreflight = true;
      i++;
      continue;
    }
    if (arg === "--report-md") {
      if (i + 1 >= argv.length) {
        result.error = "--report-md requires a path argument";
        return result;
      }
      result.reportMd = argv[++i];
      i++;
      continue;
    }
    if (arg === "--report-junit") {
      if (i + 1 >= argv.length) {
        result.error = "--report-junit requires a path argument";
        return result;
      }
      result.reportJunit = argv[++i];
      i++;
      continue;
    }
    if (arg === "--no-transforms") {
      result.noTransforms = true;
      i++;
      continue;
    }
    if (arg === "--compare") {
      if (i + 1 >= argv.length) {
        result.error = "--compare requires a git ref argument";
        return result;
      }
      result.compare = argv[++i];
      i++;
      continue;
    }
    if (arg === "--json") {
      if (i + 1 >= argv.length) {
        result.error = "--json requires a path argument";
        return result;
      }
      result.jsonPath = argv[++i];
      result.jsonExplicit = true;
      i++;
      continue;
    }
    if (arg === "--fixture") {
      if (i + 1 >= argv.length) {
        result.error = "--fixture requires a path argument";
        return result;
      }
      result.fixturePath = argv[++i];
      i++;
      continue;
    }
    if (arg === "--samples") {
      if (i + 1 >= argv.length) {
        result.error = "--samples requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
        result.error = `--samples must be a positive integer, got "${argv[i]}"`;
        return result;
      }
      result.samples = n;
      i++;
      continue;
    }
    if (arg === "--init-fixture") {
      result.initFixture = true;
      i++;
      continue;
    }
    if (arg === "--explore-budget") {
      if (i + 1 >= argv.length) {
        result.error = "--explore-budget requires a number of seconds";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0) {
        result.error = `--explore-budget must be a positive number of seconds, got "${argv[i]}"`;
        return result;
      }
      result.exploreBudgetSeconds = n;
      i++;
      continue;
    }
    if (arg === "--max-combos") {
      if (i + 1 >= argv.length) {
        result.error = "--max-combos requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
        result.error = `--max-combos must be a positive integer, got "${argv[i]}"`;
        return result;
      }
      result.maxCombos = n;
      i++;
      continue;
    }
    if (arg === "--threshold-mount") {
      if (i + 1 >= argv.length) {
        result.error = "--threshold-mount requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0) {
        result.error = `--threshold-mount must be a positive number, got "${argv[i]}"`;
        return result;
      }
      result.thresholdMount = n;
      i++;
      continue;
    }
    if (arg === "--threshold-interaction") {
      if (i + 1 >= argv.length) {
        result.error = "--threshold-interaction requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0) {
        result.error = `--threshold-interaction must be a positive number, got "${argv[i]}"`;
        return result;
      }
      result.thresholdInteraction = n;
      i++;
      continue;
    }
    if (arg === "--threshold-rerender") {
      if (i + 1 >= argv.length) {
        result.error = "--threshold-rerender requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0) {
        result.error = `--threshold-rerender must be a positive number, got "${argv[i]}"`;
        return result;
      }
      result.thresholdRerender = n;
      i++;
      continue;
    }
    if (arg === "--scale") {
      if (i + 1 >= argv.length) {
        result.error = "--scale requires a comma-separated list of integers";
        return result;
      }
      const raw = argv[++i];
      const parts = raw.split(",");
      const nums: number[] = [];
      for (const p of parts) {
        const n = Number(p.trim());
        if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
          result.error = `--scale values must be positive integers, got "${raw}"`;
          return result;
        }
        nums.push(n);
      }
      if (new Set(nums).size < 2) {
        result.error = `--scale requires at least 2 distinct positive integers, got "${raw}"`;
        return result;
      }
      result.scale = nums;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      result.error = `Unknown flag: ${arg}`;
      return result;
    }

    if (!result.componentPath) {
      result.componentPath = arg;
      result.componentPaths = [arg];
    } else {
      if (!result.componentPaths) result.componentPaths = [result.componentPath];
      result.componentPaths.push(arg);
    }
    i++;
  }

  if (!result.help && !result.version && !result.componentPath) {
    result.error = "Missing component path. Usage: 120fps <component.tsx> [more.tsx ...] [options]";
  }

  if (result.fixturePath && !result.componentPath) {
    result.error = "--fixture requires a component path";
  }

  if (!result.error && result.componentPaths && result.componentPaths.length > 1) {
    if (result.fixturePath) {
      result.error = "--fixture supports a single component path";
    }
  }

  if (!result.error && result.isolate && result.curve) {
    result.error = "--isolate cannot be combined with --curve";
  }
  if (!result.error && result.isolate && result.matrix) {
    result.error = "--isolate cannot be combined with --matrix";
  }
  // Checked against the paths as typed: directory and glob expansion happens
  // later, and a phase that cannot mean anything for the target is a usage
  // error, not a measurement that quietly reports nothing.
  if (
    !result.error &&
    result.isolate &&
    strictModeUnsupported(result.isolate, result.componentPaths ?? [])
  ) {
    result.error = VUE_STRICTMODE_ERROR;
  }
  // Two whole-run modes: one sweeps scale points, the other a prop matrix, and
  // a run does one or the other. A disable wins over its own enable everywhere
  // else, so it resolves this too instead of erroring on a mode that is off.
  if (!result.error && result.curve && !result.noCurve && result.matrix && !result.noMatrix) {
    result.error = "--curve cannot be combined with --matrix";
  }

  return result;
}

function parseCurveArg(arg: string): { propName: string; propKind: "array" | "number" } {
  const [propName, propKind] = arg.split(":");
  return { propName, propKind: propKind as "array" | "number" };
}

// --no-curve / --no-matrix win over their enables, matching --no-isolate and
// --no-react-compiler. `false` is not `undefined`: a disable is fingerprinted
// as the combo mode it resolves to, so it stays eligible for verdict reuse
// (M54), while an absent flag leaves auto-activation free to run.
export function resolveCurveOption(
  args: Pick<CliArgs, "curve" | "noCurve">,
): boolean | { propName: string; propKind: "array" | "number" } | undefined {
  if (args.noCurve) return false;
  if (args.curve === true) return true;
  if (typeof args.curve === "string") return parseCurveArg(args.curve);
  return undefined;
}

export function resolveMatrixOption(
  args: Pick<CliArgs, "matrix" | "noMatrix">,
): boolean | undefined {
  if (args.noMatrix) return false;
  if (args.matrix) return true;
  return undefined;
}

// --no-react-compiler wins over --react-compiler; undefined means auto-detect.
export function resolveReactCompilerFlag(
  args: Pick<CliArgs, "reactCompiler" | "noReactCompiler">,
): boolean | undefined {
  if (args.noReactCompiler) return false;
  if (args.reactCompiler) return true;
  return undefined;
}

export function resolveIsolationOption(
  args: Pick<CliArgs, "isolate" | "noIsolate" | "memoryCycles">,
): { phases: string[]; memoryCycles?: number } | undefined {
  if (!args.isolate || args.noIsolate) return undefined;
  return { phases: args.isolate, memoryCycles: args.memoryCycles };
}

// Stack traces are opt-in: DEBUG must be one of the conventional "enable
// everything" values, or explicitly name 120fps.
const DEBUG_EXACT_VALUES = new Set(["1", "true", "*"]);

export function isDebugStackEnabled(debugEnv: string | undefined): boolean {
  if (debugEnv === undefined) return false;
  return DEBUG_EXACT_VALUES.has(debugEnv) || debugEnv.includes("120fps");
}

export function formatCliError(err: unknown, debugEnv: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  let out = `Error: ${message}\n`;
  if (/Executable doesn't exist|playwright install/i.test(message)) {
    out += "Hint: run `npx playwright install chromium`\n";
  }
  if (isDebugStackEnabled(debugEnv) && err instanceof Error && err.stack) {
    out += err.stack + "\n";
  }
  return out;
}

// Wording kept identical to analyze.ts's resolveWrapPath/resolveCssFiles
// re-checks (src/analyze.ts) so the CLI's early exit and the pipeline's
// later throw read as the same error either way a run reaches them.
export function wrapperNotFoundMessage(wrapPath: string): string {
  return `Wrapper module not found: ${wrapPath}`;
}

export function stylesheetNotFoundMessage(cssPath: string): string {
  return `Stylesheet not found: ${cssPath}`;
}

export function helpText(): string {
  return `Usage: 120fps <component.tsx> [more.tsx ...] [options]

Options:
  --fixture <path>               Fixture file for composed component measurement
  --json <path>                  JSON output path (default: 120fps-report.json)
  --ci                           CI mode: JSON-only output, exit 1 on fail
  --samples <n>                  Sample count per measurement (default: 10)
  --max-combos <n>               Prop combos to measure (default: 8)
  --explore-budget <seconds>     Total interaction exploration budget (default: 300)
  --init-fixture                 Write a starter fixture when auto-composition is rolled back
  --scale <n,n,...>              Scale points for parameterized fixtures (default: 1,5,20,50)
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

Combo caps:
  --max-combos bounds the default prop-combo mode. Matrix mode measures every
  cell of its axes and is not bounded by it — use --no-matrix for a capped run.

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

function printHelp(): void {
  process.stdout.write(helpText());
}

export function defaultJsonPathFor(componentPath: string): string {
  const normalized = componentPath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stem = base.replace(/\.[^.]+$/, "");
  return `120fps-report.${stem}.json`;
}

// A single directory argument expands to many components, so --json can no
// longer be rejected as ambiguous: it names where the reports go, and the
// component stem is appended to it.
export function resolveReportPaths(
  componentPaths: string[],
  explicitJsonPath?: string,
): string[] {
  if (componentPaths.length === 1 && explicitJsonPath) return [explicitJsonPath];

  const prefix = explicitJsonPath?.replace(/\.json$/, "");
  const seen = new Map<string, number>();
  return componentPaths.map((p) => {
    const base = prefix ? `${prefix}.${componentStem(p)}.json` : defaultJsonPathFor(p);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : base.replace(/\.json$/, `-${count + 1}.json`);
  });
}

const JSON_NOTICE_LIST_CAP = 8;

// M64: a CI step that passed `--json out.json` and got `out.badge.json` had no
// way to learn that from the run. One line naming what was actually written.
export function formatJsonSplitNotice(reportPaths: string[]): string {
  if (reportPaths.length < 2) return "";
  const shown = reportPaths.slice(0, JSON_NOTICE_LIST_CAP);
  const rest = reportPaths.length - shown.length;
  const suffix = rest > 0 ? `, +${rest} more` : "";
  return `JSON: ${reportPaths.length} per-component reports — ${shown.join(", ")}${suffix}`;
}

function componentStem(componentPath: string): string {
  const normalized = componentPath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.[^.]+$/, "");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname ?? __dirname, "../package.json"),
        "utf-8",
      ),
    );
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
  }

  if (args.error) {
    process.stderr.write(`Error: ${args.error}\n`);
    process.exit(2);
  }

  const requested = args.componentPaths ?? [args.componentPath!];
  const expanded = expandComponentPaths(requested, nodePathReader());
  if (expanded.error) {
    process.stderr.write(`Error: ${expanded.error}\n`);
    process.exit(2);
  }
  const componentPaths = expanded.paths;
  if (componentPaths.length > 1) {
    process.stdout.write(`Measuring ${componentPaths.length} components\n`);
  }

  if (args.fixturePath && !fs.existsSync(path.resolve(args.fixturePath))) {
    process.stderr.write(`Error: Fixture file not found: ${args.fixturePath}\n`);
    process.exit(2);
  }

  if (args.wrapPath && !args.noWrap && !fs.existsSync(path.resolve(args.wrapPath))) {
    process.stderr.write(`Error: ${wrapperNotFoundMessage(args.wrapPath)}\n`);
    process.exit(2);
  }

  if (args.css && !args.noCss) {
    for (const cssPath of args.css) {
      if (!fs.existsSync(path.resolve(cssPath))) {
        process.stderr.write(`Error: ${stylesheetNotFoundMessage(cssPath)}\n`);
        process.exit(2);
      }
    }
  }

  // M49: its own mode — two sides, interleaved, no verdict. Budgets and
  // baselines keep owning CI, so compare never sets a non-zero exit.
  if (args.compare) {
    const invalid = validateCompareOptions({
      compare: args.compare,
      check: args.check,
      saveBaseline: args.saveBaseline,
      isolation: args.isolate,
    });
    if (invalid) {
      process.stderr.write(`Error: ${invalid}\n`);
      process.exit(2);
    }
    for (const componentPath of componentPaths) {
      try {
        const report = await compareAgainstRef(componentPath, args.compare, {
          samples: args.samples,
        });
        process.stdout.write(formatCompare(report) + "\n");
      } catch (err: unknown) {
        process.stderr.write(formatCliError(err, process.env.DEBUG));
        process.exit(2);
      }
    }
    process.exit(0);
  }

  const multi = componentPaths.length > 1;
  const reportPaths = multi
    ? resolveReportPaths(componentPaths, args.jsonExplicit ? args.jsonPath : undefined)
    : [args.jsonPath];
  let anyFail = false;
  // M50: collected across the sweep so both formats describe the whole run.
  const ciReports: import("./report.js").Report[] = [];

  // M37: browsers are project-agnostic — one pool serves every component of
  // the sweep (two Chromium processes total instead of ~5 launches each).
  // M38: one dev server per project/config tuple serves every harness dir.
  const pool = createBrowserPool();
  const serverPool = createServerPool();
  try {
    for (let idx = 0; idx < componentPaths.length; idx++) {
      const componentPath = componentPaths[idx];
      if (multi && !args.ci) {
        process.stdout.write(`\n=== ${componentPath} ===\n`);
      }
      try {
        const report = await runOne(componentPath, reportPaths[idx], args, pool, serverPool);
        if (!args.ci) {
          process.stdout.write(formatTable(report) + "\n");
        }
        if (!report.pass) anyFail = true;
      } catch (err: unknown) {
        if (!multi) {
          process.stderr.write(formatCliError(err, process.env.DEBUG));
          process.exit(2);
        }
        anyFail = true;
        process.stderr.write(`[${componentPath}] ` + formatCliError(err, process.env.DEBUG));
      }
    }
  } finally {
    await pool.closeAll();
    await serverPool.closeAll();
  }

  const jsonNotice = formatJsonSplitNotice(reportPaths);
  if (jsonNotice) process.stdout.write(jsonNotice + "\n");

  // Written even when components failed: a CI summary that only appears on
  // success is the one nobody needed.
  if (args.reportMd) writeCiFile(args.reportMd, formatMarkdown(ciReports));
  if (args.reportJunit) writeCiFile(args.reportJunit, formatJUnit(ciReports));

  process.exit(anyFail ? 1 : 0);
}

function writeCiFile(target: string, contents: string): void {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, contents, "utf-8");
}

async function runOne(
  componentPath: string,
  jsonPath: string,
  args: CliArgs,
  browserPool?: import("./measure.js").BrowserPool,
  serverPool?: import("./harness.js").ServerPool,
): Promise<import("./report.js").Report> {
  return analyze(componentPath, {
      browserPool,
      serverPool,
      samples: args.samples,
      maxCombos: args.maxCombos,
      initFixture: args.initFixture,
      exploreBudgetMs: args.exploreBudgetSeconds !== undefined ? args.exploreBudgetSeconds * 1000 : undefined,
      jsonPath,
      ci: args.ci,
      fixturePath: args.fixturePath,
      scalePoints: args.scale,
      skipDeltas: args.noDeltas,
      skipAutoScale: args.noAutoScale,
      skipAttribution: args.noAttribution,
      skipAutoCompose: args.noAutoCompose,
      skipReactAnalysis: args.noReactAnalysis,
      framework: args.framework,
      flatThresholds: args.flatThresholds,
      noShims: args.noShims,
      curveMode: resolveCurveOption(args),
      matrixMode: resolveMatrixOption(args),
      saveBaseline: args.saveBaseline,
      check: args.check,
      noBaseline: args.noBaseline,
      noCache: args.noCache,
      noPreflight: args.noPreflight,
      noTransforms: args.noTransforms,
      baselineEnv: args.baselineEnv,
      isolation: resolveIsolationOption(args),
      wrapPath: args.wrapPath,
      noWrap: args.noWrap,
      cssFiles: args.css,
      noCss: args.noCss,
      reactCompiler: resolveReactCompilerFlag(args),
      thresholds: {
        ...(args.thresholdMount !== undefined
          ? { mountMs: args.thresholdMount }
          : {}),
        ...(args.thresholdInteraction !== undefined
          ? { interactionMs: args.thresholdInteraction }
          : {}),
        ...(args.thresholdRerender !== undefined
          ? { rerenderMs: args.thresholdRerender }
          : {}),
      },
    });
}

// --- M32 D1: directory and glob expansion ---

export interface PathReader {
  exists: (p: string) => boolean;
  isDirectory: (p: string) => boolean;
  walk: (root: string) => string[];
}

const ACCEPTED_COMPONENT_EXTENSIONS = [".tsx", ".jsx", ".vue"];

// Extension only — directory/glob expansion additionally filters build dirs
// and test/story/fixture suffixes via isComponentFile below; a plain path
// the user named explicitly should only be rejected for its extension.
export function hasAcceptedComponentExtension(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, "/");
  if (posix.endsWith(".d.ts")) return false;
  return /\.(tsx|jsx|vue)$/.test(posix);
}

export function isComponentFile(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, "/");
  if (!hasAcceptedComponentExtension(posix)) return false;
  for (const segment of posix.split("/")) {
    for (const skip of SKIP_DIRS) {
      if (segment === skip || segment.startsWith(skip)) return false;
    }
  }
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  return !SKIP_SUFFIX.some((s) => base.includes(s));
}

// `*` stops at a separator, `**` does not. Nothing else is special, so a path
// with regex characters cannot change the meaning of a pattern.
function globToRegExp(pattern: string): RegExp {
  const posix = pattern.replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < posix.length; i++) {
    const ch = posix[i];
    if (ch === "*") {
      if (posix[i + 1] === "*") {
        out += ".*";
        i++;
        if (posix[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += /[.+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp(`^${out}$`);
}

function globRoot(pattern: string): string {
  const posix = pattern.replace(/\\/g, "/");
  const star = posix.indexOf("*");
  const cut = posix.lastIndexOf("/", star === -1 ? posix.length : star);
  return cut <= 0 ? "." : posix.slice(0, cut);
}

export function expandComponentPaths(
  args: string[],
  reader: PathReader,
): { paths: string[]; error?: string } {
  const found = new Set<string>();

  for (const arg of args) {
    // Counted per argument, not against the running set: overlapping arguments
    // are a convenience, not a mistake to report.
    const matches: string[] = [];

    if (arg.includes("*")) {
      const re = globToRegExp(arg);
      for (const file of reader.walk(globRoot(arg))) {
        const posix = file.replace(/\\/g, "/");
        if (re.test(posix) && isComponentFile(posix)) matches.push(file);
      }
    } else if (reader.exists(arg) && reader.isDirectory(arg)) {
      for (const file of reader.walk(arg)) {
        if (isComponentFile(file)) matches.push(file);
      }
    } else if (reader.exists(arg)) {
      if (!hasAcceptedComponentExtension(arg)) {
        return {
          paths: [],
          error: `${arg} is not a component file — 120fps only measures ${ACCEPTED_COMPONENT_EXTENSIONS.join(", ")} files`,
        };
      }
      matches.push(arg);
    }

    if (matches.length === 0) {
      // A plain path that is simply absent deserves the specific message; the
      // generic one is for directories and globs that yielded nothing.
      const missingFile = !arg.includes("*") && !reader.exists(arg);
      return {
        paths: [],
        error: missingFile
          ? `File not found: ${arg}`
          : `no component files matched "${arg}"`,
      };
    }
    for (const m of matches) found.add(m);
  }

  return { paths: [...found].sort() };
}

// Real filesystem behind the injected reader `expandComponentPaths` takes.
export function nodePathReader(): PathReader {
  const walk = (root: string): string[] => {
    const out: string[] = [];
    const visit = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.some((s) => entry.name === s || entry.name.startsWith(s))) continue;
          visit(full);
        } else if (entry.isFile()) {
          out.push(full);
        }
      }
    };
    visit(path.resolve(root));
    return out;
  };

  return {
    exists: (p) => fs.existsSync(path.resolve(p)),
    isDirectory: (p) => {
      try {
        return fs.statSync(path.resolve(p)).isDirectory();
      } catch {
        return false;
      }
    },
    walk,
  };
}

// Invoked last: every module-level declaration above is initialized before
// main() can run, so the direct-run path can never hit a temporal dead zone.
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));

if (isDirectRun) {
  main();
}
