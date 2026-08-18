import { describe, it, expect } from "vitest";
import { classifyEnv, describeEnvDiff, buildEnvFingerprint, METRICS_REVISION } from "../../src/budget.js";
import type { EnvFingerprint } from "../../src/report.js";

function fingerprint(overrides: Partial<EnvFingerprint> = {}): EnvFingerprint {
  return {
    shape: 1,
    metrics: METRICS_REVISION,
    cpu: "AMD Ryzen 9 5900X",
    cores: 24,
    os: "Windows_NT 10.0.26100",
    nodeVersion: "v24.15.0",
    chromiumVersion: "147.0.7727.15",
    cpuThrottle: 4,
    samples: 10,
    calibrationTotalDuration: 115,
    calibrationScriptDuration: 0.2,
    ...overrides,
  } as EnvFingerprint;
}

describe("baselines record which measurement semantics produced them", () => {
  it("stamps the current metrics revision on a new fingerprint", () => {
    const env = buildEnvFingerprint({
      machine: {
        cpu: "x",
        cores: 8,
        ramMb: 16000,
        os: "Windows_NT",
        nodeVersion: "v24",
        chromiumVersion: "147",
      },
      calibration: { totalDuration: 100, scriptDuration: 1 },
      cpuThrottle: 4,
      samples: 10,
    });
    expect(env.metrics).toBe(METRICS_REVISION);
    expect(env.shape).toBe(1);
  });

  it("treats a pre-metrics-revision baseline as incompatible rather than comparable", () => {
    const older = fingerprint({ metrics: undefined });
    expect(classifyEnv(older, fingerprint())).toBe("incompatible");
  });

  it("leaves field-shape versioning alone", () => {
    // A different `shape` still compares on shared fields; only `metrics` gates.
    expect(classifyEnv(fingerprint({ shape: 2 as 1 }), fingerprint())).toBe("identical");
  });

  it("names the revision mismatch so the user knows to re-save", () => {
    const diff = describeEnvDiff(fingerprint({ metrics: undefined }), fingerprint());
    expect(diff.join(" ").toLowerCase()).toContain("revision");
    expect(diff.join(" ").toLowerCase()).toContain("re-save");
  });

  it("still compares two current fingerprints normally", () => {
    expect(classifyEnv(fingerprint(), fingerprint())).toBe("identical");
  });

  it("keeps treating a missing fingerprint as unknown", () => {
    expect(classifyEnv(undefined, fingerprint())).toBe("unknown");
  });
});
