import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runPreflight,
  detectAsyncComponent,
  detectMissingInstall,
  preflightFailureMessage,
  NODE_BUILTIN_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
  HARD_REMEDY,
} from "../../src/project/index.js";

const ROOT = path.resolve("fixtures/m42-server");

function check(file: string, componentName?: string) {
  return runPreflight({
    projectRoot: ROOT,
    entries: [path.join(ROOT, file)],
    ...(componentName ? { componentName } : {}),
  });
}

// M72: isolated tmpdir keeps this repo's react dep and pnpm workspace out of solid-js/PnP checks.
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// M78: existing callers test solid-js/PnP, not not-installed, so the default fixture is installed.
function makeIsolatedRoot(
  prefix: string,
  files: Record<string, string>,
  options: { installed?: boolean } = {},
): { root: string; entry: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  if (options.installed !== false) {
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
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

// M72: solid-js can't be measured; with react, mixed repo, warn-only (react-profiler.test.ts).
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

  // M72: gate keys on declared packages, not resolvable; transitive solid-js isn't rejected.
  it("does not reject a transitively available but undeclared solid-js", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-transitive-solid-", {
      "package.json": JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
    });
    const solidDir = path.join(root, "node_modules", "solid-js");
    fs.mkdirSync(solidDir, { recursive: true });
    fs.writeFileSync(
      path.join(solidDir, "package.json"),
      JSON.stringify({ name: "solid-js", version: "1.8.0" }),
    );
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).not.toContain("unsupported-framework");
  });

  it("still rejects a declared solid-js when react is only transitively available", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-transitive-react-", {
      "package.json": JSON.stringify({ dependencies: { "solid-js": "^1.8.0" } }),
    });
    const reactDir = path.join(root, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "19.0.0" }),
    );
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).toContain("unsupported-framework");
  });
});

// M72: PnP's virtual fs replaces node_modules; unresolvable here, no mixed-repo exception.
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

// M78: no node_modules from member to workspace root; gated behind PnP so the two aren't confused.
describe("not-installed rejection", () => {
  it("rejects a project with no node_modules anywhere", () => {
    const { root, entry } = makeIsolatedRoot(
      "120fps-preflight-not-installed-",
      { "package.json": JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } }) },
      { installed: false },
    );
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).toContain("not-installed");
  });

  it("passes an otherwise-identical project once node_modules exists", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-installed-", {
      "package.json": JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } }),
    });
    expect(runPreflight({ projectRoot: root, entries: [entry] }).hard).toEqual([]);
  });

  it("does not report not-installed for a PnP project (never has node_modules by design)", () => {
    const { root, entry } = makeIsolatedRoot(
      "120fps-preflight-pnp-not-installed-",
      { "package.json": "{}", ".pnp.cjs": "" },
      { installed: false },
    );
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).toEqual(["yarn-pnp"]);
  });

  it("names the missing install in the failure message with no --no-preflight escape hatch", () => {
    const { root, entry } = makeIsolatedRoot(
      "120fps-preflight-not-installed-msg-",
      { "package.json": "{}" },
      { installed: false },
    );
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    const message = preflightFailureMessage(result.hard);
    expect(message).toContain("no installed dependencies");
    expect(message).not.toContain("--no-preflight");
    expect(message).toContain("npm install");
  });

  it("directly: detectMissingInstall is true when no level has node_modules", () => {
    const { root } = makeIsolatedRoot("120fps-missing-install-direct-", { "package.json": "{}" }, { installed: false });
    expect(detectMissingInstall(root, root)).toBe(true);
  });

  it("directly: detectMissingInstall is false once node_modules exists at any level", () => {
    const { root } = makeIsolatedRoot("120fps-missing-install-direct-installed-", { "package.json": "{}" });
    expect(detectMissingInstall(root, root)).toBe(false);
  });

  it("exports HARD_REMEDY verbatim so assertReactDomClient's taxonomy can reuse it", () => {
    expect(HARD_REMEDY["not-installed"]).toContain("npm install");
    expect(HARD_REMEDY["not-installed"]).not.toContain("--no-preflight");
    expect(HARD_REMEDY["yarn-pnp"]).toContain("--no-preflight");
  });
});

// M72: next/server-only isn't real; a stale entry would reject an unrelated import.
describe("dead SERVER_ONLY_PACKAGES entry removed", () => {
  it("does not treat next/server-only as the server-only marker", () => {
    const { root, entry } = makeIsolatedRoot("120fps-preflight-next-server-only-", {
      "Card.tsx": 'import "next/server-only";\nexport function Card() { return null; }\n',
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard.map((h) => h.kind)).not.toContain("server-only");
  });
});
