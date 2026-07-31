import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          testTimeout: 30000,
          poolOptions: { forks: { maxForks: 6 }, threads: { maxThreads: 6 } },
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          // A full analyze pass is 15-25s of real work in a CPU-throttled
          // browser. At 30s any contention between parallel files tipped
          // unrelated tests into timeouts that looked like product failures.
          testTimeout: 120000,
          poolOptions: { forks: { maxForks: 6 }, threads: { maxThreads: 6 } },
        },
      },
    ],
  },
});
