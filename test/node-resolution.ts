import Module from "node:module";

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
