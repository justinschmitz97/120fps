import { describe, it, expect } from "vitest";
import { phaseSessionOptions } from "../../src/isolation.js";

describe("warning sink for an isolated phase session", () => {
  it("forwards the caller's sink, so a font-settle warning survives the phase", () => {
    const seen: string[] = [];
    const options = phaseSessionOptions("churn harness", {
      onWarning: (w) => seen.push(w),
    });
    expect(options.label).toBe("churn harness");
    options.onWarning!("font loading did not settle within 5s");
    expect(seen).toEqual(["font loading did not settle within 5s"]);
  });

  it("carries the throttle and the pacing a phase chose", () => {
    const options = phaseSessionOptions("memory harness", { cpuThrottle: 4, pacing: "vsync" });
    expect(options.cpuThrottle).toBe(4);
    expect(options.pacing).toBe("vsync");
  });

  it("omits the optional keys nothing set, so a session sees today's defaults", () => {
    const options = phaseSessionOptions("strictmode harness", {});
    expect(Object.keys(options)).toEqual(["label"]);
  });

  it("passes the browser pool through", () => {
    const pool = { acquire: async () => ({}) } as never;
    expect(phaseSessionOptions("churn harness", { pool }).pool).toBe(pool);
  });
});
