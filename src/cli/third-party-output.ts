import { inspect } from "node:util";

function formatArgs(args: unknown[]): string {
  return args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" ");
}

// A library the harness build loads writes through console.error; 120fps's own diagnostics go
// straight to process.stderr. Buffering the former lets the run decide whether it adds anything.
// The capture in force, so a path that exits without unwinding can still hand the console back.
let activeCapture: (() => string[]) | undefined;

export function captureThirdPartyErrors(opts: {
  write?: (chunk: string) => void;
  debug?: boolean;
} = {}): () => string[] {
  const stream = opts.write ?? ((chunk: string): void => void process.stderr.write(chunk));
  const captured: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    const text = formatArgs(args);
    // DEBUG keeps the raw stream: a diagnosis in progress must not lose a line to buffering.
    if (opts.debug) stream(`${text}\n`);
    else captured.push(text);
  };
  const release = (): string[] => {
    if (activeCapture === release) activeCapture = undefined;
    console.error = original;
    return captured;
  };
  activeCapture = release;
  return release;
}

// Teardown writes its own failures through console.error; an abort must not buffer them away.
export function releaseThirdPartyCapture(): void {
  activeCapture?.();
}

// The frame a stack points at: `.../node_modules/<pkg>/lib/...`, pnpm's inner copy included.
const NODE_MODULES_PACKAGE = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/][^\\/]*)[\\/]/g;

const UNNAMED_TOOL = "a tool the harness build loaded";

export function thirdPartyToolName(output: string): string {
  for (const match of output.matchAll(NODE_MODULES_PACKAGE)) {
    const name = match[1]!.replace(/@[^@\\/]+$/, "");
    if (name === ".pnpm" || name === "") continue;
    return name;
  }
  return UNNAMED_TOOL;
}

// The lead line of a thrown error, which is the sentence a 120fps warning would repeat.
function reportedFact(output: string): string {
  const first = output.split("\n")[0]!.trim();
  return first.replace(/^\w*Error:\s*/, "");
}

// A 120fps warning re-words the same fact: separators, drive letters, case and wrapping differ.
function normalizeFact(text: string): string {
  return text
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\b[a-z]:\//g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

// A third party's failure is re-presented as a 120fps message, never as a bare stack.
export function thirdPartyOutputNotice(
  captured: readonly string[],
  warnings: readonly string[],
): string | undefined {
  const uncovered = captured.filter((output) => {
    const fact = normalizeFact(reportedFact(output));
    return fact.length > 0 && !warnings.some((warning) => normalizeFact(warning).includes(fact));
  });
  if (uncovered.length === 0) return undefined;
  const lines: string[] = [];
  for (const output of uncovered) {
    lines.push(
      `${thirdPartyToolName(output)} wrote this to the console during the run, and no 120fps ` +
        "warning covers it:",
    );
    lines.push(output);
  }
  return lines.join("\n");
}
