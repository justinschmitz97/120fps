import { describe, it, expect } from "vitest";
import { sameMachineIdentity, buildEnvFingerprint, METRICS_REVISION } from "../../src/budget.js";
import type { EnvFingerprint, MachineInfo } from "../../src/report.js";

const machine: MachineInfo = {
  cpu: "Test CPU",
  cores: 8,
  ramMb: 16384,
  os: "Test OS",
  nodeVersion: "v20.0.0",
  chromiumVersion: "130.0.0.0",
};

function env(overrides: Partial<EnvFingerprint> = {}): EnvFingerprint {
  return {
    ...buildEnvFingerprint({
      machine,
      calibration: { totalDuration: 40, scriptDuration: 10 },
      cpuThrottle: 4,
      samples: 10,
      mode: "combo",
    }),
    ...overrides,
  };
}

describe("M39: sameMachineIdentity", () => {
  it("holds for the same machine even when calibration drifted wildly", () => {
    // The whole point: a single calibration sample swings 20-40% on a real
    // machine; drift changes measured values, not the verdict of unchanged code.
    expect(sameMachineIdentity(env(), env({ calibrationTotalDuration: 90 }))).toBe(true);
  });

  it("breaks on any machine identity field", () => {
    expect(sameMachineIdentity(env(), env({ cpu: "Other CPU" }))).toBe(false);
    expect(sameMachineIdentity(env(), env({ chromiumVersion: "131.0.0.0" }))).toBe(false);
    expect(sameMachineIdentity(env(), env({ cpuThrottle: 8 }))).toBe(false);
    expect(sameMachineIdentity(env(), env({ samples: 2 }))).toBe(false);
  });

  it("breaks on feature fields and metrics revision", () => {
    expect(sameMachineIdentity(env(), env({ wrapper: "120fps.setup.tsx" }))).toBe(false);
    expect(sameMachineIdentity(env(), env({ mode: "isolation" }))).toBe(false);
    expect(sameMachineIdentity(env({ metrics: METRICS_REVISION - 1 }), env())).toBe(false);
  });

  it("is false without a baseline record", () => {
    expect(sameMachineIdentity(undefined, env())).toBe(false);
  });
});
