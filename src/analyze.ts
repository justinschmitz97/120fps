import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { buildAndServe, detectScaleExport, type HarnessResult } from "./harness.js";
import { extractProps, extractExports, extractAllProps, detectScalingProps, type ScalingPropMatch } from "./prop-gen.js";
import { inferComposition, type CompositionTree } from "./composition.js";
import { detectFramework, runReactAnalysis, hasReactWarning, type ReactOptimizations } from "./react-profiler.js";
import { generateCombinations, generateDeltaPairs, generateScalingCombos, type PropCombination } from "./prop-gen-values.js";
import { measureMount, measureRerender, type MountResult, type RerenderResult } from "./measure.js";
import { explore, type ExploreResult } from "./explorer.js";
import {
  createCalibrationTrace,
  computeScalingCurve,
  attributeCost,
  type ScalingCurve,
} from "./metrics.js";
import {
  buildTimingWithCV,
  classifyTier,
  computeVerdict,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  type CalibrationResult,
  type ComboReport,
  type InteractionReport,
  type MachineInfo,
  type PropDelta,
  type Report,
  type TierBudget,
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
  fixturePath?: string;
  scalePoints?: number[];
  skipDeltas?: boolean;
  skipAutoScale?: boolean;
  flatThresholds?: boolean;
  skipAttribution?: boolean;
  skipAutoCompose?: boolean;
  skipReactAnalysis?: boolean;
  framework?: "react" | "vanilla" | "auto";
  noShims?: boolean;
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
  fixturePath?: string;
  fixtureAutoDetected?: boolean;
  rerenders?: RerenderResult[];
  flatThresholds?: boolean;
  explicitThresholds?: Partial<Record<keyof TierBudget, boolean>>;
  skipAttribution?: boolean;
  autoComposition?: boolean;
  compositionTree?: import("./composition.js").CompositionTree;
  nextJsShims?: string[];
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
        const report: InteractionReport = {
          selector: edge.interaction.selector,
          type: edge.interaction.type,
          label: edge.interaction.label,
          timing: buildTimingWithCV(edge.samples),
          relativeTiming:
            input.calibration.totalDuration > 0
              ? computeMedianFromSamples(edge.samples) /
                input.calibration.totalDuration
              : 0,
        };
        if (edge.interaction.portal) report.portal = true;
        if (edge.stressPattern) report.stressPattern = edge.stressPattern;
        interactions.push(report);
      }
    }

    const relativeMount =
      input.calibration.totalDuration > 0
        ? mount.mount.median / input.calibration.totalDuration
        : 0;

    const rerenderResult = input.rerenders?.find(
      (r) => r.comboIndex === mount.comboIndex,
    );

    const rerenderTiming = rerenderResult
      ? buildTimingWithCV(rerenderResult.stable.samples)
      : buildTimingWithCV([0]);

    const combo: ComboReport = {
      comboIndex: mount.comboIndex,
      props: mount.props as Record<string, unknown>,
      mount: buildTimingWithCV(mount.mount.samples),
      unmount: buildTimingWithCV(mount.unmount.samples),
      rerender: rerenderTiming,
      domNodeCount: mount.domNodeCount,
      heapDelta: input.heapDeltas[mount.comboIndex] ?? 0,
      interactions,
      scalingCurve: null,
      relativeMount,
      verdict: "pass",
    };

    if (rerenderResult?.change) {
      combo.rerenderChange = buildTimingWithCV(rerenderResult.change.samples);
    }

    if (!input.skipAttribution && mount.mountTraces && mount.mountTraces.length > 0) {
      const allEvents = mount.mountTraces.flat();
      combo.costAttribution = attributeCost(allEvents);
    }

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

    const rerenderPoints = combos.map((c) => ({ n: c.domNodeCount, metric: c.rerender.median }));
    const rerenderCurve = computeScalingCurve(rerenderPoints);
    for (const combo of combos) {
      combo.rerenderScalingCurve = rerenderCurve;
    }
  }

  if (!input.flatThresholds) {
    for (const combo of combos) {
      const isScaleCombo = "__120fps_scaleN" in combo.props;
      const hasPortal = combo.interactions.some((i) => i.portal === true);
      const hasScaling = combo.scalingCurve != null || combo.rerenderScalingCurve != null;
      const mountResult = input.mounts.find((m) => m.comboIndex === combo.comboIndex);
      const hasAnimation = mountResult?.hasAnimation ?? false;
      const tier = classifyTier({ domNodeCount: combo.domNodeCount, hasPortal, hasScaling, hasAnimation });
      combo.tier = tier;
      combo.hasAnimation = hasAnimation;
      if (isScaleCombo) {
        combo.verdict = "pass";
      } else {
        const tierBudget = TIER_BUDGETS[tier];
        const effectiveBudget: TierBudget = {
          mountMs: input.explicitThresholds?.mountMs ? input.thresholds.mountMs : tierBudget.mountMs,
          rerenderMs: input.explicitThresholds?.rerenderMs ? input.thresholds.rerenderMs : tierBudget.rerenderMs,
          interactionMs: input.explicitThresholds?.interactionMs ? input.thresholds.interactionMs : tierBudget.interactionMs,
        };
        combo.verdict = computeVerdict(combo, input.thresholds, { tierBudget: effectiveBudget });
      }
    }
  }

  const pass = combos.every((c) => c.verdict !== "fail");

  const report: Report = {
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

  if (input.fixturePath !== undefined) {
    report.fixturePath = input.fixturePath;
    report.fixtureAutoDetected = input.fixtureAutoDetected ?? false;
  }

  if (!input.flatThresholds) {
    report.tieredBudgets = true;
  }

  if (input.autoComposition) {
    report.autoComposition = true;
  }
  if (input.compositionTree) {
    report.compositionTree = input.compositionTree;
  }

  if (input.nextJsShims && input.nextJsShims.length > 0) {
    report.nextJsShims = input.nextJsShims;
  }

  return report;
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

  const defaultFn = source.match(
    /export\s+default\s+function\s+([A-Z]\w*)/,
  );
  if (defaultFn) return defaultFn[1];

  const defaultConst = source.match(
    /export\s+default\s+([A-Z]\w*)/,
  );
  if (defaultConst) return defaultConst[1];

  const namedExport = source.match(
    /export\s+(?:const|function)\s+([A-Z]\w*)/,
  );
  if (namedExport) return namedExport[1];

  const reExport = source.match(
    /export\s+\{\s*([A-Z]\w*)\s*\}/,
  );
  if (reExport) return reExport[1];

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

  let fixturePath: string | undefined = options.fixturePath;
  let fixtureAutoDetected = false;
  const inputIsFixture = isFixturePath(componentPath);

  if (inputIsFixture) {
    fixturePath = componentPath;
  } else if (!fixturePath) {
    const detected = detectFixture(resolvedPath);
    if (detected) {
      fixturePath = detected;
      fixtureAutoDetected = true;
    }
  }

  if (fixturePath && !inputIsFixture) {
    const resolvedFixture = path.resolve(fixturePath);
    if (!fs.existsSync(resolvedFixture)) {
      throw new Error(`Fixture file not found: ${fixturePath}`);
    }
  }

  let compositionTree: CompositionTree | undefined;
  let componentExports: import("./composition.js").ExportInfo[] | undefined;
  if (!fixturePath && !inputIsFixture && !options.skipAutoCompose) {
    componentExports = await extractExports(resolvedPath);
    if (componentExports.length > 1) {
      const allSchemas = await extractAllProps(resolvedPath);
      const tree = inferComposition(componentExports, allSchemas);
      if (tree) compositionTree = tree;
    }
  }

  const useFixture = fixturePath !== undefined;
  const useComposition = compositionTree !== undefined;
  const harnessPath = useFixture ? fixturePath! : componentPath;
  const metadataPath = inputIsFixture ? componentPath : resolvedPath;

  let harness: HarnessResult | undefined;
  let browser: Browser | undefined;

  try {
    const harnessOpts: import("./harness.js").BuildHarnessOptions = {
      ...(useComposition ? { composition: compositionTree!, exports: componentExports } : {}),
      ...(options.noShims ? { noShims: true } : {}),
    };
    harness = await buildAndServe(harnessPath, harnessOpts);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);

    const chromiumVersion = browser.version();
    const machine = await collectMachineInfo(chromiumVersion);

    await page.goto(harness.url);
    await page.waitForFunction(
      () => typeof (window as any).__120fps === "object",
      { timeout: 30000 },
    );

    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

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

    let combos: PropCombination[];
    let schemas: import("./prop-gen.js").PropSchema[] | undefined;
    const resolvedHarnessPath = path.resolve(harnessPath);
    const fixtureHasScale = useFixture && detectScaleExport(resolvedHarnessPath);

    const scalePoints = options.scalePoints ?? [1, 5, 20, 50];
    if (fixtureHasScale) {
      combos = scalePoints.map((n) => ({ __120fps_scaleN: n }));
    } else if (useFixture || useComposition) {
      combos = [{}];
    } else {
      schemas = await extractProps(harness.componentPath);
      combos = generateCombinations(schemas);
      if (combos.length === 0) combos = [{}];
      if (combos.length > 16) combos = combos.slice(0, 16);
      const scaleCombos = scalePoints.map((n) => ({ __120fps_scaleN: n }));
      combos = [...combos, ...scaleCombos];
    }

    const effectiveSamples = combos.length > 20
      ? Math.max(3, Math.min(samples, Math.floor(200 / combos.length)))
      : samples;

    const mounts = await measureMount(harness, {
      samples: effectiveSamples,
      cpuThrottle,
      warmupRuns,
      combos,
    });

    const heapDeltas: number[] = mounts.map((m) => m.heapDelta ?? 0);

    const rerenders = await measureRerender(harness, {
      samples: effectiveSamples,
      cpuThrottle,
      warmupRuns,
      combos,
    });

    const exploreCombos = combos.filter((c) => !("__120fps_scaleN" in c));
    const exploreWallClockPerCombo = exploreCombos.length > 1
      ? Math.max(10000, Math.floor(60000 / exploreCombos.length))
      : 60000;
    const explores = await explore(harness, {
      samples: Math.min(samples, 5),
      cpuThrottle,
      warmupRuns,
      seed,
      combos: exploreCombos,
      maxWallClockMs: exploreWallClockPerCombo,
    });

    let propDeltas: PropDelta[] | undefined;
    if (!useFixture && !useComposition && !options.skipDeltas && schemas && schemas.length > 0) {
      const pairs = generateDeltaPairs(schemas);
      if (pairs.length > 0) {
        const measured = new Map<string, { mount: number; rerender: number }>();
        for (const m of mounts) {
          const key = JSON.stringify(m.props);
          measured.set(key, { mount: m.mount.median, rerender: 0 });
        }
        for (const r of rerenders) {
          const key = JSON.stringify(r.props);
          const existing = measured.get(key);
          if (existing) {
            existing.rerender = r.stable.median;
          }
        }

        const needed: PropCombination[] = [];
        for (const pair of pairs) {
          for (const combo of [pair.baseCombo, pair.flipCombo]) {
            const key = JSON.stringify(combo);
            if (!measured.has(key)) {
              needed.push(combo);
              measured.set(key, { mount: 0, rerender: 0 });
            }
          }
        }

        if (needed.length > 0) {
          const extraMounts = await measureMount(harness, {
            samples: effectiveSamples,
            cpuThrottle,
            warmupRuns,
            combos: needed,
          });
          const extraRerenders = await measureRerender(harness, {
            samples: effectiveSamples,
            cpuThrottle,
            warmupRuns,
            combos: needed,
          });
          for (const m of extraMounts) {
            measured.set(JSON.stringify(m.props), { mount: m.mount.median, rerender: 0 });
          }
          for (const r of extraRerenders) {
            const key = JSON.stringify(r.props);
            const existing = measured.get(key);
            if (existing) {
              existing.rerender = r.stable.median;
            }
          }
        }

        propDeltas = pairs.map((pair) => {
          const baseKey = JSON.stringify(pair.baseCombo);
          const flipKey = JSON.stringify(pair.flipCombo);
          const base = measured.get(baseKey) ?? { mount: 0, rerender: 0 };
          const flip = measured.get(flipKey) ?? { mount: 0, rerender: 0 };
          return {
            propName: pair.propName,
            baseValue: pair.baseValue,
            flipValue: pair.flipValue,
            mountDelta: flip.mount - base.mount,
            rerenderDelta: flip.rerender - base.rerender,
          };
        });
        propDeltas.sort((a, b) => Math.abs(b.mountDelta) - Math.abs(a.mountDelta));
      }
    }

    const componentName = detectComponentName(metadataPath);

    const explicitThresholds: Partial<Record<keyof TierBudget, boolean>> = {};
    if (options.thresholds?.mountMs !== undefined) explicitThresholds.mountMs = true;
    if (options.thresholds?.rerenderMs !== undefined) explicitThresholds.rerenderMs = true;
    if (options.thresholds?.interactionMs !== undefined) explicitThresholds.interactionMs = true;

    const report = buildReport({
      componentPath,
      componentName,
      machine,
      calibration,
      mounts,
      explores,
      heapDeltas,
      thresholds,
      rerenders,
      flatThresholds: options.flatThresholds,
      explicitThresholds,
      skipAttribution: options.skipAttribution,
      ...(useFixture
        ? {
            fixturePath: inputIsFixture ? componentPath : fixturePath,
            fixtureAutoDetected,
          }
        : {}),
      ...(useComposition
        ? {
            autoComposition: true,
            compositionTree: compositionTree!,
          }
        : {}),
      nextJsShims: harness.nextJsShims,
    });

    if (propDeltas) {
      report.propDeltas = propDeltas;
    }

    let autoScalingMatch: ScalingPropMatch | undefined;
    if (!fixtureHasScale && !useFixture && !useComposition && !options.skipAutoScale && schemas && schemas.length > 0) {
      const matches = detectScalingProps(schemas);
      if (matches.length > 0) {
        autoScalingMatch = matches[0];
        const scalePoints = options.scalePoints ?? [1, 5, 20, 50];
        const scaleCombos = generateScalingCombos(schemas, autoScalingMatch, scalePoints);

        const scaleMounts = await measureMount(harness, {
          samples,
          cpuThrottle,
          warmupRuns,
          combos: scaleCombos,
        });
        const scaleRerenders = await measureRerender(harness, {
          samples,
          cpuThrottle,
          warmupRuns,
          combos: scaleCombos,
        });

        const mountPoints = scaleMounts.map((m) => ({
          n: scalePoints[m.comboIndex],
          metric: m.mount.median,
        }));
        const rerenderPoints = scaleRerenders.map((r) => ({
          n: scalePoints[r.comboIndex],
          metric: r.stable.median,
        }));

        if (mountPoints.length >= 2) {
          const curve = computeScalingCurve(mountPoints);
          for (const combo of report.combos) {
            combo.scalingCurve = curve;
          }
        }
        if (rerenderPoints.length >= 2) {
          const rerenderCurve = computeScalingCurve(rerenderPoints);
          for (const combo of report.combos) {
            combo.rerenderScalingCurve = rerenderCurve;
          }
        }

        report.autoScalingProp = autoScalingMatch.schema.name;
        report.autoScalingReason = autoScalingMatch.reason;
      }
    }

    // --- React optimization detection (separate pass) ---
    const frameworkMode = options.framework ?? "auto";
    const entryContent = fs.readFileSync(
      path.join(harness.harnessDir, "entry.tsx"),
      "utf-8",
    );
    const detectedFramework = detectFramework(entryContent);

    if (frameworkMode === "react" && detectedFramework !== "react") {
      throw new Error("--framework react specified but React was not detected in the bundle");
    }

    const shouldRunReact =
      !options.skipReactAnalysis &&
      frameworkMode !== "vanilla" &&
      detectedFramework === "react";

    if (shouldRunReact) {
      const fnPropNames = schemas
        ? schemas.filter((s) => s.kind === "function").map((s) => s.name)
        : [];

      const reactResults = await runReactAnalysis(harness, {
        combos,
        samples: Math.min(samples, 3),
        cpuThrottle,
        warmupRuns: 1,
        fnPropNames,
      });

      for (const combo of report.combos) {
        const opts = reactResults.get(combo.comboIndex);
        if (opts) {
          combo.reactOptimizations = opts;
          if (combo.verdict === "pass" && hasReactWarning(opts)) {
            combo.verdict = "warn";
          }
        }
      }
    }

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

export function hasScaleExport(source: string): boolean {
  return /export\s+(?:function|const)\s+scale\b/.test(source);
}

export function isFixturePath(filePath: string): boolean {
  return /\.fixture\.[jt]sx?$/.test(filePath);
}

export function detectFixture(componentPath: string): string | undefined {
  const ext = path.extname(componentPath);
  const stem = componentPath.slice(0, -ext.length);
  for (const candidate of [`${stem}.fixture.tsx`, `${stem}.fixture.ts`]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}
