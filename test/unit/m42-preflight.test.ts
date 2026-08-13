import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  runPreflight,
  detectAsyncComponent,
  preflightFailureMessage,
  NODE_BUILTIN_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
} from "../../src/preflight.js";

const ROOT = path.resolve("fixtures/m42-server");

function check(file: string, componentName?: string) {
  return runPreflight({
    projectRoot: ROOT,
    entries: [path.join(ROOT, file)],
    ...(componentName ? { componentName } : {}),
  });
}

// C1 — the boundary is real and permanent; fail before booting anything.
describe("m42 C1 — hard failures", () => {
  it("finds a transitive server-only import", () => {
    const { hard } = check("reaches-server-only.tsx");
    expect(hard.map((h) => h.kind)).toContain("server-only");
  });

  it("records the chain from the measured file to the boundary", () => {
    const hit = check("reaches-server-only.tsx").hard.find((h) => h.kind === "server-only")!;
    expect(hit.chain).toEqual(["reaches-server-only.tsx", "lib/data.ts"]);
    expect(hit.specifier).toBe("server-only");
  });

  it("finds a \"use server\" module in the graph", () => {
    const { hard } = check("reaches-use-server.tsx");
    const hit = hard.find((h) => h.kind === "use-server");
    expect(hit).toBeDefined();
    expect(hit!.chain).toEqual(["reaches-use-server.tsx", "lib/action.ts"]);
  });

  it("finds an async function component", () => {
    const { hard } = check("async-component.tsx", "AsyncCard");
    expect(hard.map((h) => h.kind)).toContain("async-component");
  });

  it("passes a component that reaches none of them", () => {
    expect(check("clean.tsx", "Clean").hard).toEqual([]);
  });
});

// C2 — a type-only edge is erased before it reaches a browser.
describe("m42 C2 — type-only imports are not a boundary", () => {
  it("does not follow a type-only import into server code", () => {
    const result = check("type-only.tsx", "TypeOnly");
    expect(result.hard).toEqual([]);
    expect(result.soft).toEqual([]);
  });
});

// C3 — Vite may externalize a builtin; warn, do not fail.
describe("m42 C3 — soft signals", () => {
  it("warns about a Node builtin without failing", () => {
    const result = check("reaches-node-builtin.tsx", "ReachesNodeBuiltin");
    expect(result.hard).toEqual([]);
    expect(result.soft.map((h) => h.specifier)).toContain("node:fs");
  });

  it("names the chain in the warning", () => {
    const hit = check("reaches-node-builtin.tsx").soft[0];
    expect(NODE_BUILTIN_WARNING(hit)).toContain("lib/env.ts");
    expect(NODE_BUILTIN_WARNING(hit)).toContain("node:fs");
  });
});

// C4 — the message is the deliverable: what broke, where, what to do.
describe("m42 C4 — failure message", () => {
  it("shows the chain and an escape hatch", () => {
    const message = preflightFailureMessage(check("reaches-server-only.tsx").hard);
    expect(message).toContain("reaches-server-only.tsx → lib/data.ts → server-only");
    expect(message).toContain("--no-preflight");
    expect(message).toContain("lib/data.ts");
  });

  it("names an async component as the cause", () => {
    const message = preflightFailureMessage(check("async-component.tsx", "AsyncCard").hard);
    expect(message).toContain("async function component");
  });

  it("lists what a bypass skipped", () => {
    const warning = PREFLIGHT_BYPASSED_WARNING(check("reaches-server-only.tsx").hard);
    expect(warning).toContain("--no-preflight");
    expect(warning).toContain("lib/data.ts");
  });
});

// H1..H6 — hardening.
describe("m42 hardening", () => {
  it("H1: a non-existent entry does not throw", () => {
    expect(() => check("does-not-exist.tsx")).not.toThrow();
  });

  it("H2: a component named differently from the async export is not flagged", () => {
    expect(check("async-component.tsx", "SomethingElse").hard.map((h) => h.kind))
      .not.toContain("async-component");
  });

  it("H3: a sync component is not mistaken for an async one", () => {
    expect(detectAsyncComponent(path.join(ROOT, "clean.tsx"), "Clean")).toBe(false);
  });

  it("H4: a \"use server\" string that is not a directive does not count", () => {
    // lib/data.ts contains no directive prologue at all.
    expect(check("reaches-server-only.tsx").hard.map((h) => h.kind)).not.toContain("use-server");
  });

  it("H5: the walk terminates on a graph it has already seen", () => {
    const first = check("reaches-server-only.tsx");
    const second = check("reaches-server-only.tsx");
    expect(second.hard.length).toBe(first.hard.length);
  });

  it("H6: a wrapper entry is walked too", () => {
    const result = runPreflight({
      projectRoot: ROOT,
      entries: [path.join(ROOT, "clean.tsx"), path.join(ROOT, "reaches-server-only.tsx")],
      componentName: "Clean",
    });
    expect(result.hard.map((h) => h.kind)).toContain("server-only");
  });
});
