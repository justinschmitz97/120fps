import fs from "node:fs";
import path from "node:path";
import { type ViteDevServer } from "vite";
import { findWorkspaceRoot } from "../project/index.js";
import { sweepStaleTmpDirs } from "./dirs.js";
import { resolveJsxImportSource } from "./renderer.js";
import { resolvePosix } from "../shared/index.js";

// One server per config tuple serves a whole sweep: Vite serves files created after boot.
export interface ServerPool {
  acquire(
    key: string,
    boot: () => Promise<ViteDevServer>,
    include: string[],
  ): Promise<{ server: ViteDevServer; reused: boolean; include: Set<string> }>;
  stats(): { booted: number };
  closeAll(): Promise<void>;
}

// Vite's server.close() has a shape where it never settles, so callers race it instead.
export const SERVER_CLOSE_TIMEOUT_MS = 5000;

export async function closeServerBounded(
  server: Pick<ViteDevServer, "close">,
  timeoutMs: number = SERVER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  await Promise.race([
    server.close().catch(() => {}),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      // Unref'd: a hung close() holds other handles open, so this still fires on schedule.
      timer.unref();
    }),
  ]);
}

export function createServerPool(): ServerPool {
  // Best-effort: the sweep swallows its own errors, so it cannot block pool creation.
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
        // Frozen at first boot: the list is part of the config hash, and a change re-bundles.
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

// Forced automatic: a project's "jsx": "preserve" would break JSX with React is not defined.
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

// A Vue project keeps the vue plugin's own SFC compilation and receives no esbuild key.
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

// A changed optimizeDeps.include changes Vite's config hash and forces a ~10s re-bundle.
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

// An alias into a sibling package or into a linked install of this tool is outside the root.
export function fsAllowDirs(
  memberRoot: string,
  workspaceRoot: string,
  aliases: Array<{ replacement: string }>,
  // Directories no alias names: the component's own when its import routes through /@fs/.
  extraDirs: string[] = [],
): string[] | undefined {
  const forward = (p: string) => resolvePosix(p);
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
  // Undefined keeps Vite's own defaults, right whenever every target is inside memberRoot.
  if (outside.length === 0) return undefined;
  return [...new Set([forward(memberRoot), forward(workspaceRoot), ...outside])];
}
