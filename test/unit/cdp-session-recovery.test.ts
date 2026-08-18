import { describe, it, expect } from "vitest";
import { isContextLostError, refreshCdpSession, type CdpHolder } from "../../src/measure.js";

describe("CDP session recovery: a wedged tracing session is recoverable", () => {
  it("classifies a tracing timeout as retryable again", () => {
    expect(isContextLostError(new Error("Tracing.tracingComplete timed out"))).toBe(true);
  });

  it("replaces the session and detaches the old one", async () => {
    let detached = 0;
    const created: object[] = [];
    const holder: CdpHolder = { cdp: { detach: async () => { detached++; } } as never };
    const page = {
      context: () => ({
        newCDPSession: async () => {
          const s = { id: created.length } as never;
          created.push(s);
          return s;
        },
      }),
    } as never;

    await refreshCdpSession(page, holder);
    expect(detached).toBe(1);
    expect(holder.cdp).toBe(created[0]);
  });

  it("still replaces the session when detaching the old one throws", async () => {
    const holder: CdpHolder = {
      cdp: { detach: async () => { throw new Error("already gone"); } } as never,
    };
    const fresh = {} as never;
    const page = { context: () => ({ newCDPSession: async () => fresh }) } as never;

    await refreshCdpSession(page, holder);
    expect(holder.cdp).toBe(fresh);
  });
});
