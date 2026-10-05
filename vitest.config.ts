import { defineConfig } from "vitest/config";

// The 99% statements and lines gate applies whenever coverage is collected.
// `pnpm test` runs without coverage until the first ported module lands with
// its tests; that pull request switches the script to `vitest run --coverage`
// and drops passWithNoTests, so an empty tests/ can never pass silently again.
//
// The raised timeouts leave room for the concurrency tests, which start
// several writer processes against one memory directory.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
      thresholds: {
        statements: 99,
        lines: 99,
      },
    },
  },
});
