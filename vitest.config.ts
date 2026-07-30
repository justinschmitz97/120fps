import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    // e2e files each launch throttled Chromium; unbounded parallelism starves
    // harness startup past its 30s ready-timeout on typical dev machines.
    poolOptions: {
      forks: { maxForks: 6 },
      threads: { maxThreads: 6 },
    },
  },
});
