import Module from "node:module";

// vitest exports NODE_PATH pointing at pnpm's hoisted virtual store, so inside
// the test process every installed package resolves from every directory. A
// real run has no NODE_PATH, so the "declared but not installed" paths are only
// observable with it removed. Module._initPaths re-reads it.
export function withProductionResolution<T>(fn: () => T): T {
  const initPaths = (Module as unknown as { _initPaths(): void })._initPaths;
  const saved = process.env.NODE_PATH;
  delete process.env.NODE_PATH;
  initPaths();
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = saved;
    initPaths();
  }
}
