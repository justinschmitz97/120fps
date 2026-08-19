import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
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

// M72: solid-js and Yarn PnP rejection both key off package.json/workspace
// markers that must not be polluted by this repo's own react devDependency
// or pnpm workspace, so each gets an isolated os.tmpdir() root rather than a
// fixture nested under this repository (matching workspace-root-discovery.test.ts).
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeIsolatedRoot(prefix: string, files: Record<string, string>): { root: string; entry: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const entry = path.join(root, "Card.tsx");
  if (!files["Card.tsx"]) fs.writeFileSync(entry, "export function Card() { return null; }\n");
  return { root, entry };
}

// C1: the boundary is real and permanent; fail before booting anything.
describe("hard failures", () => {
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

// C2: a type-only edge is erased before it reaches a browser.
describe("type-only imports are not a boundary", () => {
  it("does not follow a type-only import into server code", () => {
    const result = check("type-only.tsx", "TypeOnly");
    expect(result.hard).toEqual([]);
    expect(result.soft).toEqual([]);
  });
});

// C3: Vite may externalize a builtin; warn, do not fail.
describe("soft signals", () => {
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

// C4: the message is the deliverable: what broke, where, what to do.
describe("failure message", () => {
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

// H1..H6: hardening.
describe("hardening", () => {
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

// M72: solid-js declared without react cannot be measured; declared alongside
// react it is a mixed repo and only warns (see detectFramework in
// react-profiler.test.ts for that half).
describe("solid-js rejection", () => {
  it("rejects a project that declares solid-js and no react", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-solid-", {
      "package.json": JSON.stringify({ dependencies: { "solid-js": "^1.8.0" } }),
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).toContain("unsupported-framework");
  });

  it("does not reject when both react and solid-js are declared", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-mixed-", {
      "package.json": JSON.stringify({
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "solid-js": "^1.8.0" },
      }),
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).not.toContain("unsupported-framework");
  });

  it("passes a project with neither package declared", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-neither-", {
      "package.json": JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
    });
    expect(runPreflight({ projectRoot: root, entries: [entry] }).hard).toEqual([]);
  });

  it("names Solid in the failure message without the server-boundary remedy", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-solid-msg-", {
      "package.json": JSON.stringify({ dependencies: { "solid-js": "^1.8.0" } }),
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    const message = preflightFailureMessage(result.hard);
    expect(message).toContain("Solid");
    expect(message).not.toContain("Extract the client part");
  });
});

// M72: PnP swaps node_modules for a virtual filesystem this harness cannot
// resolve through; unconditional, no mixed-repo exception.
describe("Yarn PnP rejection", () => {
  it("rejects a workspace carrying .pnp.cjs", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-pnp-cjs-", {
      "package.json": "{}",
      ".pnp.cjs": "",
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).toContain("yarn-pnp");
  });

  it("rejects a workspace carrying .pnp.loader.mjs", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-pnp-mjs-", {
      "package.json": "{}",
      ".pnp.loader.mjs": "",
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).toContain("yarn-pnp");
  });

  it("names Yarn Plug'n'Play in the failure message", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-pnp-msg-", {
      "package.json": "{}",
      ".pnp.cjs": "",
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(preflightFailureMessage(result.hard)).toContain("Plug'n'Play");
  });

  it("passes a workspace with no PnP markers", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-no-pnp-", {
      "package.json": "{}",
    });
    expect(runPreflight({ projectRoot: root, entries: [entry] }).hard).toEqual([]);
  });
});

// M72: "next/server-only" was never a real module; a stale entry here would
// hard-reject an import that could not have caused the problem it claims to.
describe("dead SERVER_ONLY_PACKAGES entry removed", () => {
  it("does not treat next/server-only as the server-only marker", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-next-server-only-", {
      "Card.tsx": 'import "next/server-only";\nexport function Card() { return null; }\n',
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).not.toContain("server-only");
  });
});
