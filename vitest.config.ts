import { defineConfig } from "vitest/config";

// The 99% statements and lines gate applies on every `pnpm test`, which runs
// `vitest run --coverage`, so CI fails as soon as coverage drops.
//
// The raised timeouts leave room for the concurrency tests, which start
// several writer processes against one memory directory.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
      // The executable only wires main() to the real process; main() is tested.
      exclude: ["src/bin.ts"],
      thresholds: {
        statements: 99,
        lines: 99,
      },
    },
  },
});
