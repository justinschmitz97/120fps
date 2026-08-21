import { describe, it, expect, afterEach } from "vitest";
import {
  hardRemedyFor,
  HARD_REMEDY,
  PREFLIGHT_BYPASSED_WARNING,
  preflightFailureMessage,
  setPreflightBypassed,
  type PreflightHit,
} from "../../src/preflight.js";

afterEach(() => {
  setPreflightBypassed(false);
});

function hit(kind: PreflightHit["kind"], chain: string[]): PreflightHit {
  return { kind, chain } as PreflightHit;
}

// pnp-app: a Yarn PnP rejection reported as a "server-boundary finding", a
// category preflight.ts's own HARD_CAUSE table says it is not.
describe("naming what --no-preflight bypassed", () => {
  it("names a yarn-pnp finding as its own kind", () => {
    const warning = PREFLIGHT_BYPASSED_WARNING([hit("yarn-pnp", ["src/04-sortable/simple/Card.tsx"])]);
    expect(warning).toContain("1 yarn-pnp finding");
    expect(warning).not.toContain("server-boundary");
    expect(warning).toContain("src/04-sortable/simple/Card.tsx");
  });

  it("keeps server-boundary for the three kinds that are one", () => {
    for (const kind of ["server-only", "use-server", "async-component"] as const) {
      expect(PREFLIGHT_BYPASSED_WARNING([hit(kind, ["a.tsx"])])).toContain("1 server-boundary finding");
    }
  });

  it("names a solid rejection as solid", () => {
    expect(PREFLIGHT_BYPASSED_WARNING([hit("unsupported-framework", ["b.tsx"])])).toContain(
      "1 solid finding",
    );
  });

  it("counts each kind separately when several were bypassed", () => {
    const warning = PREFLIGHT_BYPASSED_WARNING([
      hit("server-only", ["a.tsx"]),
      hit("use-server", ["b.tsx"]),
      hit("yarn-pnp", ["c.tsx"]),
    ]);
    expect(warning).toContain("3 findings");
    expect(warning).toContain("2 server-boundary");
    expect(warning).toContain("1 yarn-pnp");
    expect(warning).toContain("a.tsx");
    expect(warning).toContain("c.tsx");
  });
});

// solid-ui: the run that printed "Pass --no-preflight to attempt the run
// anyway" had already passed it, two lines above its own bypass warning.
describe("advising a flag the run already used", () => {
  it("drops the bypass advice once the run is bypassing preflight", () => {
    expect(hardRemedyFor("unsupported-framework")).toContain("--no-preflight");
    setPreflightBypassed(true);
    const remedy = hardRemedyFor("unsupported-framework");
    expect(remedy).not.toContain("Pass --no-preflight");
    expect(remedy).toContain("120fps measures React and Vue components");
  });

  it("drops it for every kind that carries it, and changes nothing else", () => {
    setPreflightBypassed(true);
    for (const kind of ["server-only", "use-server", "async-component", "yarn-pnp"] as const) {
      expect(hardRemedyFor(kind)).not.toContain("Pass --no-preflight");
    }
    // The kind that never offered the escape hatch is untouched.
    expect(hardRemedyFor("not-installed")).toBe(HARD_REMEDY["not-installed"]);
  });

  it("leaves the failure message's diagnosis intact", () => {
    setPreflightBypassed(true);
    const message = preflightFailureMessage([hit("yarn-pnp", ["packages/examples/src/Card.tsx"])]);
    expect(message).toContain("Yarn Plug'n'Play");
    expect(message).toContain("packages/examples/src/Card.tsx");
    expect(message).not.toContain("Pass --no-preflight");
  });

  it("restores the advice for a run that did not pass the flag", () => {
    setPreflightBypassed(true);
    setPreflightBypassed(false);
    expect(hardRemedyFor("yarn-pnp")).toContain("Pass --no-preflight");
  });
});
