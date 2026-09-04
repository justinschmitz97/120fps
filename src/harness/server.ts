import fs from "node:fs";
import path from "node:path";
import { type ViteDevServer } from "vite";
import { findWorkspaceRoot } from "../project/index.js";
import { sweepStaleTmpDirs } from "./dirs.js";
import { resolveJsxImportSource } from "./renderer.js";

// M38: the dev server's root is projectRoot and every harness dir lives under
// it, so one server per config tuple serves a whole sweep. Vite serves files
// created after boot on demand: later components need no restart.
export interface ServerPool {
  acquire(
    key: string,
    boot: () => Promise<ViteDevServer>,
    include: string[],
  ): Promise<{ server: ViteDevServer; reused: boolean; include: Set<string> }>;
  stats(): { booted: number };
  closeAll(): Promise<void>;
}

// M88: Vite's own dev-server teardown has a known shape (previously observed
// only in vitest's own dev-server teardown after an explicit
// transformRequest()) where server.close() never settles. Both callers that
// await a server's own close() -- buildAndServe's cleanup() and the pool's
// closeAll() below -- race it against an unref'd timer instead of awaiting it
// unconditionally, so a single hung server can never block the caller (and,
// transitively, the process from exiting) forever. Unref'd: this timer alone
// never keeps an otherwise-idle process alive, but a hung close() leaves
// other handles open regardless, so it still fires on schedule.
export const SERVER_CLOSE_TIMEOUT_MS = 5000;

export async function closeServerBounded(
  server: Pick<ViteDevServer, "close">,
  timeoutMs: number = SERVER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  await Promise.race([
    server.close().catch(() => {}),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

export function createServerPool(): ServerPool {
  // M56: once per session, best-effort: errors are swallowed inside the
  // sweep itself, so this can never fail or block pool creation.
  sweepStaleTmpDirs();
  const servers = new Map<string, Promise<{ server: ViteDevServer; include: Set<string> }>>();
  let closed = false;
  let booted = 0;
  return {
    async acquire(key, boot, include) {
      if (closed) throw new Error("server pool is closed");
      let entry = servers.get(key);
      let reused = true;
      if (!entry) {
        reused = false;
        booted++;
        // The include list is frozen at first boot: it is part of the Vite
        // config hash, and changing it per component would force a dep
        // re-bundle for every component of the sweep (M34).
        entry = boot().then((server) => ({ server, include: new Set(include) }));
        servers.set(key, entry);
      }
      const resolved = await entry;
      return { server: resolved.server, reused, include: resolved.include };
    },
    stats: () => ({ booted }),
    async closeAll() {
      closed = true;
      for (const entry of servers.values()) {
        try {
          await closeServerBounded((await entry).server);
        } catch {
          // Already closed, or boot failed: nothing left to release.
        }
      }
      servers.clear();
    },
  };
}

// M109 (A3, ark-F1): with no esbuild option of its own, vite:esbuild reads the
// project tsconfig for the ts/tsx loaders, so ark's `"jsx": "preserve"` (the
// standard Vite library setup, where the project's own plugin-react supplies
// the runtime the harness does not run) fell through to esbuild's classic
// React.createElement transform. ark imports only named React exports, so the
// first JSX evaluation threw `React is not defined` and every .tsx in the
// repository was mis-transformed. These are the two settings jsxInJsPlugin has
// applied to project .js files since M77.
export function harnessEsbuildOptions(
  projectRoot: string,
  workspaceRoot?: string,
  forFile?: string,
): { jsx: "automatic"; jsxImportSource: string } {
  return {
    jsx: "automatic",
    jsxImportSource: resolveJsxImportSource(
      projectRoot,
      workspaceRoot ?? findWorkspaceRoot(projectRoot),
      forFile,
    ),
  };
}

// The two compile-shaping keys createServer receives, in one place a test can
// hold: a Vue project keeps the vue plugin's own compilation of its SFC blocks
// and receives no esbuild key at all.
export function harnessServerCompileOptions(
  renderer: string,
  projectRoot: string,
  workspaceRoot: string,
  componentPath: string,
  resolveConditions: string[],
): {
  esbuild?: { jsx: "automatic"; jsxImportSource: string };
  conditions?: string[];
} {
  return {
    ...(renderer === "vue"
      ? {}
      : { esbuild: harnessEsbuildOptions(projectRoot, workspaceRoot, componentPath) }),
    ...(resolveConditions.length > 0 ? { conditions: resolveConditions } : {}),
  };
}

// M34: any change to optimizeDeps.include changes Vite's config hash, and a
// changed hash forces a full dependency re-bundle (~10s) on the next run. The
// scanned list varies per component, so every component of a sweep paid it.
// Union the list with whatever the project's dep cache already optimized: the
// list converges to a stable superset and repeat runs hit the cache. A missing
// or corrupt cache costs one re-bundle, nothing else.
export function unionCachedDeps(
  include: string[],
  metadataJson: string | undefined,
): string[] {
  let cached: string[] = [];
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson) as { optimized?: Record<string, unknown> };
      cached = Object.keys(parsed.optimized ?? {});
    } catch {
      // Not ours to repair; Vite rewrites it on the next optimize pass.
    }
  }
  return [...new Set([...include, ...cached])].sort();
}

export function readDepCacheMetadata(projectRoot: string): string | undefined {
  try {
    return fs.readFileSync(
      path.join(projectRoot, "node_modules", ".vite", "deps", "_metadata.json"),
      "utf8",
    );
  } catch {
    return undefined;
  }
}

// M69: Vite serves nothing outside its allow list, and the harness root is the
// member package. An alias into a sibling package or into a linked install of
// this tool is outside it. Undefined keeps Vite's own defaults, which is every
// project whose targets are all inside the member root.
// M73: extraDirs carries directories no alias names — the component's own
// directory when its import routes through /@fs/. An empty list reproduces the
// alias-only answer exactly, undefined included.
export function fsAllowDirs(
  memberRoot: string,
  workspaceRoot: string,
  aliases: Array<{ replacement: string }>,
  extraDirs: string[] = [],
): string[] | undefined {
  const forward = (p: string) => path.resolve(p).replace(/\\/g, "/");
  const targets = aliases.map(({ replacement }) => {
    const trimmed = replacement.replace(/[\\/]+$/, "");
    if (!trimmed) return forward(replacement);
    try {
      if (fs.statSync(trimmed).isDirectory()) return forward(trimmed);
    } catch {
      // A stale alias target: its parent is the directory that would hold it.
    }
    return forward(path.dirname(trimmed));
  });

  const inside = (dir: string) => {
    const relative = path.relative(memberRoot, dir);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const outside = [...targets, ...extraDirs.map(forward)].filter((dir) => !inside(dir));
  if (outside.length === 0) return undefined;
  return [...new Set([forward(memberRoot), forward(workspaceRoot), ...outside])];
}
