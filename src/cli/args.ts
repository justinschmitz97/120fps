import { parseIsolationPhases, strictModeUnsupported, VUE_STRICTMODE_ERROR } from "../analysis/index.js";
import { hasAcceptedComponentExtension } from "./paths.js";

const ISOLATE_USAGE_ERROR =
  "--isolate requires a comma-separated list of phases (mount,rerender,unmount,memory,strictmode,all)";

export interface CliArgs {
  componentPath?: string;
  // Export names from `<file>#Export`, keyed by the path as typed.
  targets?: Record<string, string>;
  explainProps?: boolean;
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
  "--explain-props",
  "--compare",
  "--report-md",
  "--report-junit",
  "--help",
  "--version",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Text alone, no filesystem: a path whose own name contains # stays a whole path.
export function splitTargetSpec(arg: string): { path: string; target?: string } {
  const hash = arg.lastIndexOf("#");
  if (hash <= 0) return { path: arg };
  const left = arg.slice(0, hash);
  const right = arg.slice(hash + 1);
  if (!IDENTIFIER.test(right)) return { path: arg };
  if (!hasAcceptedComponentExtension(left)) return { path: arg };
  return { path: left, target: right };
}

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
    if (arg === "--explain-props") {
      result.explainProps = true;
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

    const spec = splitTargetSpec(arg);
    if (spec.target) {
      result.targets = { ...(result.targets ?? {}), [spec.path]: spec.target };
    }
    if (!result.componentPath) {
      result.componentPath = spec.path;
      result.componentPaths = [spec.path];
    } else {
      if (!result.componentPaths) result.componentPaths = [result.componentPath];
      result.componentPaths.push(spec.path);
    }
    i++;
  }

  if (!result.help && !result.version && !result.componentPath) {
    result.error = "Missing component path. Usage: 120fps <component.tsx> [more.tsx ...] [options]";
  }

  if (result.fixturePath && !result.componentPath) {
    result.error = "--fixture requires a component path";
  }

  if (!result.error && result.fixturePath && result.targets) {
    result.error =
      "--fixture cannot be combined with a named export target (<file>#Export): a fixture already decides what renders";
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
  // Paths as typed: expansion happens later, and an impossible phase is a usage error.
  if (
    !result.error &&
    result.isolate &&
    strictModeUnsupported(result.isolate, result.componentPaths ?? [])
  ) {
    result.error = VUE_STRICTMODE_ERROR;
  }
  // A disable wins over its own enable, so a disabled mode never triggers this conflict.
  if (!result.error && result.curve && !result.noCurve && result.matrix && !result.noMatrix) {
    result.error = "--curve cannot be combined with --matrix";
  }

  return result;
}

function parseCurveArg(arg: string): { propName: string; propKind: "array" | "number" } {
  const [propName, propKind] = arg.split(":");
  return { propName, propKind: propKind as "array" | "number" };
}

// false is not undefined: a disable fingerprints as combo mode; absent leaves auto-activation.
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
