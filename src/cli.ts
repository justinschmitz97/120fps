#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { analyze } from "./analyze.js";
import { formatTable, DEFAULT_THRESHOLDS } from "./report.js";

export interface CliArgs {
  componentPath?: string;
  jsonPath: string;
  ci: boolean;
  samples?: number;
  thresholdMount?: number;
  thresholdInteraction?: number;
  help: boolean;
  version: boolean;
  error?: string;
}

const KNOWN_FLAGS = new Set([
  "--json",
  "--ci",
  "--samples",
  "--threshold-mount",
  "--threshold-interaction",
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
    if (arg === "--json") {
      if (i + 1 >= argv.length) {
        result.error = "--json requires a path argument";
        return result;
      }
      result.jsonPath = argv[++i];
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
    if (arg.startsWith("--")) {
      result.error = `Unknown flag: ${arg}`;
      return result;
    }

    if (!result.componentPath) {
      result.componentPath = arg;
    } else {
      result.error = `Unexpected argument: ${arg}`;
      return result;
    }
    i++;
  }

  if (!result.help && !result.version && !result.componentPath) {
    result.error = "Missing component path. Usage: 120fps <component.tsx> [options]";
  }

  return result;
}

function printHelp(): void {
  process.stdout.write(`Usage: 120fps <component.tsx> [options]

Options:
  --json <path>                  JSON output path (default: 120fps-report.json)
  --ci                           CI mode: JSON-only output, exit 1 on fail
  --samples <n>                  Sample count per measurement (default: 10)
  --threshold-mount <ms>         Mount time threshold (default: ${DEFAULT_THRESHOLDS.mountMs})
  --threshold-interaction <ms>   Interaction time threshold (default: ${DEFAULT_THRESHOLDS.interactionMs})
  --help                         Show this help
  --version                      Print version
`);
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

  if (!fs.existsSync(path.resolve(args.componentPath!))) {
    process.stderr.write(`Error: File not found: ${args.componentPath}\n`);
    process.exit(2);
  }

  try {
    const report = await analyze(args.componentPath!, {
      samples: args.samples,
      jsonPath: args.jsonPath,
      ci: args.ci,
      thresholds: {
        ...(args.thresholdMount !== undefined
          ? { mountMs: args.thresholdMount }
          : {}),
        ...(args.thresholdInteraction !== undefined
          ? { interactionMs: args.thresholdInteraction }
          : {}),
      },
    });

    if (!args.ci) {
      process.stdout.write(formatTable(report) + "\n");
    }

    process.exit(report.pass ? 0 : 1);
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));

if (isDirectRun) {
  main();
}
