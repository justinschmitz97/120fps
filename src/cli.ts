#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { analyze } from "./analyze.js";
import { formatTable, DEFAULT_THRESHOLDS } from "./report.js";

export interface CliArgs {
  componentPath?: string;
  fixturePath?: string;
  jsonPath: string;
  ci: boolean;
  samples?: number;
  thresholdMount?: number;
  thresholdInteraction?: number;
  thresholdRerender?: number;
  scale?: number[];
  noDeltas?: boolean;
  noAutoScale?: boolean;
  noAttribution?: boolean;
  noAutoCompose?: boolean;
  noReactAnalysis?: boolean;
  framework?: "react" | "vanilla" | "auto";
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
  componentPaths?: string[];
  jsonExplicit?: boolean;
  isolate?: string[];
  memoryCycles?: number;
  noIsolate?: boolean;
  help: boolean;
  version: boolean;
  error?: string;
}

export const KNOWN_FLAGS = new Set([
  "--json",
  "--ci",
  "--samples",
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
  "--isolate",
  "--memory-cycles",
  "--no-isolate",
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
        result.error = "--framework requires a value (react, vanilla, or auto)";
        return result;
      }
      const val = argv[++i];
      if (val !== "react" && val !== "vanilla" && val !== "auto") {
        result.error = `--framework must be react, vanilla, or auto, got "${val}"`;
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
    if (arg === "--no-baseline") {
      result.noBaseline = true;
      i++;
      continue;
    }
    if (arg === "--isolate") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        result.error = "--isolate requires a comma-separated list of phases (mount,rerender,unmount,memory,strictmode,all)";
        return result;
      }
      const raw = argv[++i];
      const validPhases = new Set(["mount", "rerender", "unmount", "memory", "strictmode", "all"]);
      const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const p of parts) {
        if (!validPhases.has(p)) {
          result.error = `Invalid isolation phase: "${p}". Valid phases: mount, rerender, unmount, memory, strictmode, all`;
          return result;
        }
      }
      if (parts.length === 1 && parts[0] === "all") {
        result.isolate = ["mount", "rerender", "unmount", "memory", "strictmode"];
      } else {
        result.isolate = [...new Set(parts)];
      }
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
    } else if (result.jsonExplicit) {
      result.error =
        "--json with multiple component paths is ambiguous; omit it to write 120fps-report.<name>.json per component";
    }
  }

  if (!result.error && result.isolate && result.curve) {
    result.error = "--isolate cannot be combined with --curve";
  }
  if (!result.error && result.isolate && result.matrix) {
    result.error = "--isolate cannot be combined with --matrix";
  }

  return result;
}

function parseCurveArg(arg: string): { propName: string; propKind: "array" | "number" } {
  const [propName, propKind] = arg.split(":");
  return { propName, propKind: propKind as "array" | "number" };
}

export function resolveIsolationOption(
  args: Pick<CliArgs, "isolate" | "noIsolate" | "memoryCycles">,
): { phases: string[]; memoryCycles?: number } | undefined {
  if (!args.isolate || args.noIsolate) return undefined;
  return { phases: args.isolate, memoryCycles: args.memoryCycles };
}

export function formatCliError(err: unknown, debugEnv: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  let out = `Error: ${message}\n`;
  if (/Executable doesn't exist|playwright install/i.test(message)) {
    out += "Hint: run `npx playwright install chromium`\n";
  }
  if (debugEnv !== undefined && debugEnv.includes("120fps") && err instanceof Error && err.stack) {
    out += err.stack + "\n";
  }
  return out;
}

export function helpText(): string {
  return `Usage: 120fps <component.tsx> [more.tsx ...] [options]

Options:
  --fixture <path>               Fixture file for composed component measurement
  --json <path>                  JSON output path (default: 120fps-report.json)
  --ci                           CI mode: JSON-only output, exit 1 on fail
  --samples <n>                  Sample count per measurement (default: 10)
  --scale <n,n,...>              Scale points for parameterized fixtures (default: 1,5,20,50)
  --no-deltas                    Skip pairwise prop delta analysis
  --no-auto-scale                Disable auto-scaling prop detection
  --no-attribution               Disable cost attribution analysis
  --no-auto-compose              Disable auto-composition inference
  --no-react-analysis            Disable React optimization detection
  --framework <react|vanilla|auto>  Framework detection mode (default: auto)
  --flat-thresholds              Disable tiered budgets, use flat thresholds
  --curve [prop:type]             Enable curve mode (auto-detect or specify prop:array|number)
  --no-curve                     Disable auto-activation of curve mode
  --matrix                       Enable prop variation matrix mode
  --no-matrix                    Disable auto-activation of matrix mode
  --save-baseline                Save current measurements as baseline
  --check                        Compare against baseline, fail on regression
  --budget                       Shorthand for --ci --check
  --no-baseline                  Skip baseline comparison in CI mode
  --isolate <phases>             Isolated measurement: mount,rerender,unmount,memory,strictmode,all
  --memory-cycles <n>            Mount/unmount cycles for memory mode (default: 20)
  --no-isolate                   Disable isolation mode (overrides --isolate)
  --no-shims                     Disable Next.js module shims
  --threshold-mount <ms>         Mount time threshold (default: ${DEFAULT_THRESHOLDS.mountMs})
  --threshold-interaction <ms>   Interaction time threshold (default: ${DEFAULT_THRESHOLDS.interactionMs})
  --threshold-rerender <ms>      Rerender time threshold (default: ${DEFAULT_THRESHOLDS.rerenderMs})
  --help                         Show this help
  --version                      Print version
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

export function resolveReportPaths(componentPaths: string[]): string[] {
  const seen = new Map<string, number>();
  return componentPaths.map((p) => {
    const base = defaultJsonPathFor(p);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : base.replace(/\.json$/, `-${count + 1}.json`);
  });
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

  const componentPaths = args.componentPaths ?? [args.componentPath!];

  for (const componentPath of componentPaths) {
    if (!fs.existsSync(path.resolve(componentPath))) {
      process.stderr.write(`Error: File not found: ${componentPath}\n`);
      process.exit(2);
    }
  }

  if (args.fixturePath && !fs.existsSync(path.resolve(args.fixturePath))) {
    process.stderr.write(`Error: Fixture file not found: ${args.fixturePath}\n`);
    process.exit(2);
  }

  const multi = componentPaths.length > 1;
  const reportPaths = multi ? resolveReportPaths(componentPaths) : [args.jsonPath];
  let anyFail = false;

  for (let idx = 0; idx < componentPaths.length; idx++) {
    const componentPath = componentPaths[idx];
    if (multi && !args.ci) {
      process.stdout.write(`\n=== ${componentPath} ===\n`);
    }
    try {
      const report = await runOne(componentPath, reportPaths[idx], args);
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

  process.exit(anyFail ? 1 : 0);
}

async function runOne(
  componentPath: string,
  jsonPath: string,
  args: CliArgs,
): Promise<import("./report.js").Report> {
  return analyze(componentPath, {
      samples: args.samples,
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
      curveMode: args.noCurve ? false : args.curve === true ? true : typeof args.curve === "string" ? parseCurveArg(args.curve) : undefined,
      matrixMode: args.noMatrix ? false : args.matrix ? true : undefined,
      saveBaseline: args.saveBaseline,
      check: args.check,
      noBaseline: args.noBaseline,
      isolation: resolveIsolationOption(args),
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

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));

if (isDirectRun) {
  main();
}
