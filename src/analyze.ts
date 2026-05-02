import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { buildAndServe, type HarnessResult } from "./harness.js";
import { extractProps } from "./prop-gen.js";
import { generateCombinations, type PropCombination } from "./prop-gen-values.js";
import { measureMount, type MountResult } from "./measure.js";
import { explore, type ExploreResult } from "./explorer.js";
import {
  createCalibrationTrace,
  computeScalingCurve,
  type ScalingCurve,
} from "./metrics.js";
import {
  buildTimingWithCV,
  computeVerdict,
  DEFAULT_THRESHOLDS,
  type CalibrationResult,
  type ComboReport,
  type InteractionReport,
  type MachineInfo,
  type Report,
  type Thresholds,
  type TimingWithCV,
} from "./report.js";

export interface AnalyzeOptions {
  samples?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  seed?: number;
  jsonPath?: string;
  ci?: boolean;
  thresholds?: Partial<Thresholds>;
}

export interface BuildReportInput {
  componentPath: string;
  componentName: string;
  machine: MachineInfo;
  calibration: CalibrationResult;
  mounts: MountResult[];
  explores: ExploreResult[];
  heapDeltas: number[];
  thresholds: Thresholds;
}

export function buildReport(input: BuildReportInput): Report {
  const combos: ComboReport[] = [];

  for (const mount of input.mounts) {
    const exploreResult = input.explores.find(
      (e) => e.comboIndex === mount.comboIndex,
    );

    const interactions: InteractionReport[] = [];
    if (exploreResult) {
      for (const edge of exploreResult.graph.edges) {
        interactions.push({
          selector: edge.interaction.selector,
          type: edge.interaction.type,
          label: edge.interaction.label,
          timing: buildTimingWithCV(edge.samples),
          relativeTiming:
            input.calibration.totalDuration > 0
              ? computeMedianFromSamples(edge.samples) /
                input.calibration.totalDuration
              : 0,
        });
      }
    }

    const relativeMount =
      input.calibration.totalDuration > 0
        ? mount.mount.median / input.calibration.totalDuration
        : 0;

    const combo: ComboReport = {
      comboIndex: mount.comboIndex,
      props: mount.props as Record<string, unknown>,
      mount: buildTimingWithCV(mount.mount.samples),
      unmount: buildTimingWithCV(mount.unmount.samples),
      domNodeCount: mount.domNodeCount,
      heapDelta: input.heapDeltas[mount.comboIndex] ?? 0,
      interactions,
      scalingCurve: null,
      relativeMount,
      verdict: "pass",
    };

    combo.verdict = computeVerdict(combo, input.thresholds);
    combos.push(combo);
  }

  const distinctDomSizes = new Set(combos.map((c) => c.domNodeCount));
  if (distinctDomSizes.size >= 2) {
    const points = combos.map((c) => ({ n: c.domNodeCount, metric: c.mount.median }));
    const curve = computeScalingCurve(points);
    for (const combo of combos) {
      combo.scalingCurve = curve;
    }
  }

  const pass = combos.every((c) => c.verdict !== "fail");

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    machine: input.machine,
    componentPath: input.componentPath,
    componentName: input.componentName,
    calibration: input.calibration,
    combos,
    thresholds: input.thresholds,
    pass,
  };
}

function computeMedianFromSamples(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function detectComponentName(componentPath: string): string {
  const source = fs.readFileSync(componentPath, "utf-8");

  const namedExport = source.match(
    /export\s+(?:const|function)\s+([A-Z]\w*)/,
  );
  if (namedExport) return namedExport[1];

  const defaultFn = source.match(
    /export\s+default\s+function\s+([A-Z]\w*)/,
  );
  if (defaultFn) return defaultFn[1];

  const basename = path.basename(componentPath, path.extname(componentPath));
  return basename.charAt(0).toUpperCase() + basename.slice(1);
}

async function collectMachineInfo(
  chromiumVersion: string,
): Promise<MachineInfo> {
  const cpus = os.cpus();
  return {
    cpu: cpus.length > 0 ? cpus[0].model : "unknown",
    cores: cpus.length,
    ramMb: Math.round(os.totalmem() / (1024 * 1024)),
    os: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    chromiumVersion,
  };
}

export async function analyze(
  componentPath: string,
  options: AnalyzeOptions = {},
): Promise<Report> {
  const resolvedPath = path.resolve(componentPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const thresholds: Thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options.thresholds,
  };

  const samples = options.samples ?? 10;
  const cpuThrottle = options.cpuThrottle ?? 4;
  const warmupRuns = options.warmupRuns ?? 2;
  const seed = options.seed ?? 42;

  let harness: HarnessResult | undefined;
  let browser: Browser | undefined;

  try {
    harness = await buildAndServe(componentPath);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    const chromiumVersion = browser.version();
    const machine = await collectMachineInfo(chromiumVersion);

    await page.goto(harness.url);
    await page.waitForFunction(
      () => typeof (window as any).__120fps === "object",
      { timeout: 10000 },
    );

    const calibrationMetrics = await createCalibrationTrace(page, cdp);
    const calibration: CalibrationResult = {
      totalDuration: calibrationMetrics.totalDuration,
      scriptDuration: calibrationMetrics.scriptDuration,
    };

    if (calibration.totalDuration === 0) {
      throw new Error("Calibration produced zero duration — measurement environment is broken");
    }

    await browser.close();
    browser = undefined;

    const schemas = await extractProps(harness.componentPath);
    let combos = generateCombinations(schemas);
    if (combos.length === 0) combos = [{}];

    const mounts = await measureMount(harness, {
      samples,
      cpuThrottle,
      warmupRuns,
      combos,
    });

    const heapDeltas: number[] = mounts.map((m) => m.heapDelta ?? 0);

    const explores = await explore(harness, {
      samples,
      cpuThrottle,
      warmupRuns,
      seed,
      combos,
      maxWallClockMs: 60000,
    });

    const componentName = detectComponentName(resolvedPath);

    const report = buildReport({
      componentPath,
      componentName,
      machine,
      calibration,
      mounts,
      explores,
      heapDeltas,
      thresholds,
    });

    const jsonPath = options.jsonPath ?? "120fps-report.json";
    const jsonDir = path.dirname(path.resolve(jsonPath));
    fs.mkdirSync(jsonDir, { recursive: true });
    fs.writeFileSync(
      path.resolve(jsonPath),
      JSON.stringify(report, mapReplacer, 2),
      "utf-8",
    );

    return report;
  } finally {
    if (browser) await browser.close();
    if (harness) await harness.cleanup();
  }
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}
