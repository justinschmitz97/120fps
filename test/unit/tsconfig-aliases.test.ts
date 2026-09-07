import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTsconfigAliases, TYPES_ONLY_ALIAS_WARNING } from "../../src/project/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-tsconf-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const fwd = (p: string) => p.replace(/\\/g, "/");

describe("loadTsconfigAliases", () => {
  it("resolves plain paths without baseUrl relative to the config dir", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }),
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@/components/Button")).toBe(true);
    expect(aliases[0].find.test("other/thing")).toBe(false);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });

  it("tolerates JSONC comments and trailing commas", () => {
    const dir = mkProject({
      "tsconfig.json": `{
  // line comment
  "compilerOptions": {
    /* block comment */
    "paths": {
      "@/*": ["./src/*"],
    },
  },
}`,
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });

  it("resolves paths declared in an extends chain relative to the declaring config", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
      "config/base.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["../src/*"] } },
      }),
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    // ../src relative to config/ → <root>/src
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });

  it("resolves extends given as an array", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: ["./a.json", "./b.json"] }),
      "a.json": JSON.stringify({
        compilerOptions: { paths: { "@a/*": ["./liba/*"] } },
      }),
      "b.json": JSON.stringify({ compilerOptions: { target: "es2020" } }),
      "liba/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@a/thing")).toBe(true);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/liba/`);
  });

  it("uses resolved baseUrl as the alias base when set", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: "./app", paths: { "~/*": ["lib/*"] } },
      }),
      "app/lib/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/app/lib/`);
  });

  it("returns [] when there is no tsconfig.json", () => {
    const dir = mkProject({ "src/x.ts": "export const x = 1;" });
    expect(loadTsconfigAliases(dir)).toEqual([]);
  });

  it("returns [] plus one stderr warning for malformed tsconfig", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const dir = mkProject({
      "tsconfig.json": `{ "compilerOptions": { "paths": { `,
    });
    expect(loadTsconfigAliases(dir)).toEqual([]);
    const warnings = write.mock.calls.filter((c) =>
      String(c[0]).includes("tsconfig"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("uses only the first target for multi-target paths", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: { "multi/*": ["./first/*", "./second/*"] },
        },
      }),
      "first/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/first/`);
  });

  it("supports exact (non-wildcard) aliases", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "#utils": ["./src/utils/index.ts"] } },
      }),
      "src/utils/index.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("#utils")).toBe(true);
    expect(aliases[0].find.test("#utils/deep")).toBe(false);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/utils/index.ts`);
  });

  // M69: paths and baseUrl both absent; baseUrl-set case is in base-url-import-resolution.test.ts.
  it("returns [] when paths is absent", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/x.ts": "export const x = 1;",
    });
    expect(loadTsconfigAliases(dir)).toEqual([]);
  });

  it("escapes regex metacharacters in alias patterns", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "$lib/*": ["./src/lib/*"] } },
      }),
      "src/lib/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("$lib/thing")).toBe(true);
    expect(aliases[0].find.test("xlib/thing")).toBe(false);
  });

  it("skips paths entries with an empty target list", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@empty/*": [], "@ok/*": ["./ok/*"] } },
      }),
      "ok/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@ok/x")).toBe(true);
  });
});

// M76: workspaceRoot's own tsconfig is a second layer; bare-tmpdir fixtures above never engage it.
function mkWorkspaceMember(
  rootFiles: Record<string, string>,
  memberFiles: Record<string, string>,
): { root: string; member: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-tsconf-ws-"));
  cleanupDirs.push(root);
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - member\n");
  for (const [rel, content] of Object.entries(rootFiles)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const member = path.join(root, "member");
  fs.mkdirSync(member, { recursive: true });
  for (const [rel, content] of Object.entries(memberFiles)) {
    const full = path.join(member, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { root, member };
}

describe("loadTsconfigAliases: workspace-root fallback (M76)", () => {
  it("adds a workspace-root paths pattern the member's own tsconfig does not declare", () => {
    const { root, member } = mkWorkspaceMember(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@mantine/hooks": ["./packages/hooks/src/index.ts"] } },
        }),
        "packages/hooks/src/index.ts": "export const useX = 1;",
      },
      {
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      },
    );
    const aliases = loadTsconfigAliases(member);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@mantine/hooks")).toBe(true);
    expect(aliases[0].replacement).toBe(`${fwd(root)}/packages/hooks/src/index.ts`);
    expect(aliases[0].fromWorkspaceRoot).toEqual({
      pattern: "@mantine/hooks",
      target: "./packages/hooks/src/index.ts",
      configFile: `${fwd(root)}/tsconfig.json`,
    });
  });

  it("falls back to the workspace root when the member has no tsconfig at all", () => {
    const { root, member } = mkWorkspaceMember(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@root/only": ["./root-only.ts"] } },
        }),
        "root-only.ts": "export const x = 1;",
      },
      {},
    );
    const aliases = loadTsconfigAliases(member);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@root/only")).toBe(true);
    expect(aliases[0].replacement).toBe(`${fwd(root)}/root-only.ts`);
  });

  it("does NOT fall back to the workspace root for a member that declares baseUrl and deliberately no paths", () => {
    // M76: baseUrl-only fallback is out of scope, distinct from the no-tsconfig case above.
    const { member } = mkWorkspaceMember(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@root/only": ["./root-only.ts"] } },
        }),
        "root-only.ts": "export const x = 1;",
      },
      {
        "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      },
    );
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(member, warnings);
    expect(aliases.every((a) => a.fromWorkspaceRoot === undefined)).toBe(true);
    expect(aliases.some((a) => a.find.test("@root/only"))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("single-package project (workspaceRoot === projectRoot) is unaffected: no root layer to probe", () => {
    const dir = mkProject({ "src/x.ts": "export const x = 1;" });
    expect(loadTsconfigAliases(dir)).toEqual([]);
  });

  it("member's own wildcard pattern wins over the workspace root's, even when the member's own target does not resolve to anything on disk", () => {
    // M77's loadable-entry check scopes only the non-wildcard branch; precedence still holds here.
    const { member } = mkWorkspaceMember(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@shared/*": ["./real-shared/*"] } },
        }),
        "real-shared/x.ts": "export const x = 1;",
      },
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@shared/*": ["./missing-shared/*"] } },
        }),
      },
    );
    const aliases = loadTsconfigAliases(member);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].fromWorkspaceRoot).toBeUndefined();
    expect(aliases[0].replacement).toBe(`${fwd(member)}/missing-shared/`);
  });

  it("member's own exact pattern wins over the workspace root's declaration of the same name", () => {
    const { member } = mkWorkspaceMember(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "#shared": ["./root-shared.ts"] } },
        }),
        "root-shared.ts": "export const x = 1;",
      },
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "#shared": ["./member-shared.ts"] } },
        }),
        "member-shared.ts": "export const x = 1;",
      },
    );
    const aliases = loadTsconfigAliases(member);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].fromWorkspaceRoot).toBeUndefined();
    expect(aliases[0].replacement).toBe(`${fwd(member)}/member-shared.ts`);
  });
});

// M77: a non-wildcard paths target with no runtime entry never becomes a Vite alias.
describe("loadTsconfigAliases: types-only paths targets (M77)", () => {
  it("skips a paths entry whose target has only .d.ts files and no package.json main/module/exports", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { react: ["./node_modules/@types/react"] } },
      }),
      "node_modules/@types/react/package.json": JSON.stringify({ name: "@types/react" }),
      "node_modules/@types/react/index.d.ts": "export {};",
    });
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(aliases).toEqual([]);
    expect(warnings).toEqual([
      TYPES_ONLY_ALIAS_WARNING("react", "./node_modules/@types/react"),
    ]);
  });

  it("still builds a sibling alias whose target does resolve", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: {
            react: ["./node_modules/@types/react"],
            "@/*": ["./src/*"],
          },
        },
      }),
      "node_modules/@types/react/package.json": JSON.stringify({ name: "@types/react" }),
      "node_modules/@types/react/index.d.ts": "export {};",
      "src/x.ts": "export const x = 1;",
    });
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@/components/Button")).toBe(true);
    expect(warnings).toEqual([
      TYPES_ONLY_ALIAS_WARNING("react", "./node_modules/@types/react"),
    ]);
  });

  it("keeps the exact (non-wildcard) alias from the existing test suite: its target is a real file", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "#utils": ["./src/utils/index.ts"] } },
      }),
      "src/utils/index.ts": "export const x = 1;",
    });
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(aliases).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

// Declaration order is not precedence: two keys can match one import, and tsc picks the longer.
describe("two path aliases that both match one import", () => {
  it("puts the longer prefix ahead of the shorter one", () => {
    const root = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["./core/*"], "@/app/*": ["./app/*"] },
        },
      }),
      "core/keep.ts": "export const keep = 1;\n",
      "app/asset.ts": "export const asset = 1;\n",
    });

    const aliases = loadTsconfigAliases(root);
    const first = aliases.find((alias) => alias.find.test("@/app/asset"));

    expect(first).toBeDefined();
    expect("@/app/asset".replace(first!.find, first!.replacement)).toBe(
      fwd(path.join(root, "app", "asset")),
    );
  });

  it("keeps an exact key ahead of every wildcard", () => {
    const root = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["./core/*"], "@/one": ["./app/one.ts"] },
        },
      }),
      "core/one.ts": "export const one = 1;\n",
      "app/one.ts": "export const one = 1;\n",
    });

    const aliases = loadTsconfigAliases(root);
    const first = aliases.find((alias) => alias.find.test("@/one"));

    expect(first!.replacement).toContain("app/one.ts");
  });
});
