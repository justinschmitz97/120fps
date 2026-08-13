import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  KNOWN_FLAGS,
  helpText,
  parseArgs,
  resolveCurveOption,
  resolveMatrixOption,
  type CliArgs,
} from "../../src/cli.js";
import {
  MATRIX_BASELINE_WARNING,
  baselineWorkflowRequested,
  optionsAllowVerdictReuse,
  type AnalyzeOptions,
} from "../../src/analyze.js";
import { buildEnvFingerprint, sameMachineIdentity } from "../../src/budget.js";
import type { EnvFingerprint, MachineInfo } from "../../src/report.js";

const MACHINE: MachineInfo = {
  cpu: "Test CPU",
  cores: 8,
  os: "win32",
  nodeVersion: "v20.0.0",
  chromiumVersion: "130.0.0.0",
};

function env(overrides: Partial<Parameters<typeof buildEnvFingerprint>[0]> = {}): EnvFingerprint {
  return buildEnvFingerprint({
    machine: MACHINE,
    calibration: { totalDuration: 40, scriptDuration: 10 },
    cpuThrottle: 4,
    samples: 10,
    mode: "combo",
    ...overrides,
  });
}

// The gate the pipeline actually evaluates, assembled the way runOne does.
function gateFor(argv: string[]): boolean {
  const args = parseArgs(["./Button.tsx", ...argv]);
  expect(args.error).toBeUndefined();
  return optionsAllowVerdictReuse({
    check: args.check,
    noCache: args.noCache,
    noBaseline: args.noBaseline,
    saveBaseline: args.saveBaseline,
    curveMode: resolveCurveOption(args),
    matrixMode: resolveMatrixOption(args),
    baselineEnv: args.baselineEnv,
    ...(args.isolate ? { isolation: { phases: args.isolate } } : {}),
  });
}

// H1: a slot saved by a curve run must never satisfy a --no-matrix check —
// mode is a feature field, and features differing is incomparability.
describe("H1: a curve-mode slot never serves a combo-mode reuse", () => {
  it("mode mismatch fails machine identity", () => {
    expect(sameMachineIdentity(env({ mode: "curve" }), env({ mode: "combo" }))).toBe(false);
  });

  it("an isolation-mode slot fails the same way", () => {
    expect(sameMachineIdentity(env({ mode: "isolation" }), env({ mode: "combo" }))).toBe(false);
  });

  it("a combo slot on the same machine still passes", () => {
    expect(sameMachineIdentity(env(), env())).toBe(true);
  });
});

// H2: reuse is a read; saving is a write that needs numbers.
describe("H2: --no-matrix --check --save-baseline measures", () => {
  it("the disable does not rescue a save", () => {
    expect(gateFor(["--no-matrix", "--check", "--save-baseline"])).toBe(false);
  });
});

// H3: isolation measures phases a combo slot never recorded.
describe("H3: isolation always measures", () => {
  it("--no-matrix --check --isolate mount is not eligible", () => {
    expect(gateFor(["--no-matrix", "--check", "--isolate", "mount"])).toBe(false);
  });
});

// H4: a disable is not a request to compare anything.
describe("H4: a mode disable without --check reuses nothing", () => {
  it("--no-curve alone is not eligible", () => {
    expect(gateFor(["--no-curve"])).toBe(false);
  });

  it("--no-curve --no-matrix alone is not eligible", () => {
    expect(gateFor(["--no-curve", "--no-matrix"])).toBe(false);
  });
});

// H5: --budget sets --ci, and CI is exactly where a silent no-op does the most
// damage. The disclosure must not depend on the terminal being watched.
describe("H5: --budget on a matrix run discloses and does not gate", () => {
  it("--budget implies the baseline request", () => {
    const args = parseArgs(["./Button.tsx", "--budget"]);
    expect(args.ci).toBe(true);
    expect(baselineWorkflowRequested({ check: args.check })).toBe(true);
  });

  it("the disclosure is a warning, so it names no verdict", () => {
    expect(MATRIX_BASELINE_WARNING).not.toMatch(/\bfail(ed|ing|s)?\b/i);
  });
});

// H6: order and interleaved flags must not hide the conflict.
describe("H6: the --curve/--matrix conflict is order independent", () => {
  it("errors with flags interleaved", () => {
    expect(parseArgs(["./Button.tsx", "--matrix", "--samples", "5", "--curve"]).error).toBe(
      "--curve cannot be combined with --matrix",
    );
    expect(parseArgs(["./Button.tsx", "--curve", "--samples", "5", "--matrix"]).error).toBe(
      "--curve cannot be combined with --matrix",
    );
  });

  it("a real usage error earlier in the line still wins", () => {
    expect(parseArgs(["./Button.tsx", "--samples", "0", "--curve", "--matrix"]).error).toContain(
      "--samples",
    );
  });
});

// H7: contradictory enable/disable pairs. The repo convention is that the
// disable wins (--no-isolate, --no-react-compiler, --no-css, --no-wrap).
describe("H7: --matrix --no-matrix keeps disable-wins", () => {
  it("parses without error", () => {
    expect(parseArgs(["./Button.tsx", "--matrix", "--no-matrix"]).error).toBeUndefined();
  });

  it("resolves to the disabled mode", () => {
    expect(resolveMatrixOption({ matrix: true, noMatrix: true })).toBe(false);
    expect(resolveCurveOption({ curve: true, noCurve: true })).toBe(false);
  });

  it("and is therefore reuse-eligible under --check", () => {
    expect(gateFor(["--matrix", "--no-matrix", "--check"])).toBe(true);
  });
});

// H8: the existing parity guard walks KNOWN_FLAGS → help, so a flag missing
// from both sides passes it. This is the other direction.
describe("H8: every flag in the help text is a known flag", () => {
  it("reverse parity holds", () => {
    const documented = new Set(
      (helpText().match(/(?<=^ {2})--[a-z-]+/gm) ?? []).map((f) => f.trim()),
    );
    expect(documented.size).toBeGreaterThan(20);
    for (const flag of documented) {
      expect(KNOWN_FLAGS.has(flag), `KNOWN_FLAGS missing ${flag}`).toBe(true);
    }
  });
});

// H9: the README options block is the flag list a user reads before
// installing. A flag mentioned only in prose is not listed.
describe("H9: the README options block lists every known flag", () => {
  it("no drift against KNOWN_FLAGS", () => {
    const readme = fs.readFileSync(path.resolve(__dirname, "../../README.md"), "utf-8");
    const block = readme.match(/## CLI\s+```[\s\S]*?```/)?.[0];
    expect(block, "README has no fenced CLI options block").toBeDefined();
    for (const flag of KNOWN_FLAGS) {
      expect(block!.includes(flag), `README options block missing ${flag}`).toBe(true);
    }
  });
});

// H10: pre-fingerprint slots carry no env at all.
describe("H10: a legacy slot without env never reuses", () => {
  it("machine identity against an absent baseline env is false", () => {
    expect(sameMachineIdentity(undefined, env())).toBe(false);
  });
});

// H11: the prop:type form of --curve is still an explicit enable.
describe("H11: --curve prop:array --check measures", () => {
  it("is not eligible", () => {
    expect(gateFor(["--curve", "items:array", "--check"])).toBe(false);
  });
});

// H12: no baseline flag, no warning — the matrix path must stay quiet for the
// runs that never asked for a baseline.
describe("H12: no spurious matrix warning", () => {
  it("--no-baseline alone requests nothing", () => {
    expect(baselineWorkflowRequested({ noBaseline: true })).toBe(false);
  });

  it("a plain matrix run requests nothing", () => {
    expect(baselineWorkflowRequested({})).toBe(false);
  });
});

// H13: a warning that names a flag which does not exist is worse than none.
describe("H13: the warning's workaround is a real flag", () => {
  it("every flag it names is known", () => {
    const named = MATRIX_BASELINE_WARNING.match(/--[a-z-]+/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const flag of named) {
      expect(KNOWN_FLAGS.has(flag), `warning names unknown flag ${flag}`).toBe(true);
    }
  });
});

// H14: M53 made the probe fingerprint the REQUESTED sample count, so a
// sample-throttled entry fails reuse and the run measures. The relaxed gate
// must not have moved that guard.
describe("H14: sample-count honesty survives the relaxation", () => {
  it("the options gate carries no samples term of its own", () => {
    const base: AnalyzeOptions = { check: true, matrixMode: false };
    expect(optionsAllowVerdictReuse({ ...base, samples: 3 })).toBe(true);
    expect(optionsAllowVerdictReuse({ ...base, samples: 50 })).toBe(true);
  });

  it("a throttled entry still fails machine identity against the requested count", () => {
    expect(sameMachineIdentity(env({ samples: 3 }), env({ samples: 10 }))).toBe(false);
  });
});

// H15: the env policies that ask for a different comparison must still measure,
// disable flag or not.
describe("H15: non-normalize env policies always measure", () => {
  it("strict and ignore are ineligible with a disable flag present", () => {
    expect(gateFor(["--no-matrix", "--check", "--baseline-env", "strict"])).toBe(false);
    expect(gateFor(["--no-matrix", "--check", "--baseline-env", "ignore"])).toBe(false);
    expect(gateFor(["--no-matrix", "--check", "--baseline-env", "normalize"])).toBe(true);
  });
});

// H16: the CLI type must keep the disable flags optional-boolean, or the
// resolvers silently start returning undefined for a typo'd field.
describe("H16: resolvers read the flags the parser writes", () => {
  it("parseArgs output feeds the resolvers directly", () => {
    const args: CliArgs = parseArgs(["./Button.tsx", "--no-matrix", "--no-curve"]);
    expect(args.noMatrix).toBe(true);
    expect(args.noCurve).toBe(true);
    expect(resolveMatrixOption(args)).toBe(false);
    expect(resolveCurveOption(args)).toBe(false);
  });
});
