import { defineConfig } from "tsdown";

// One ESM entry for Node 22. platform "node" would default fixedExtension to
// true and emit .mjs and .d.mts; package.json's `exports` points at
// lib/index.js and lib/index.d.ts, so the build names its files the way the
// package type does.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["esm"],
  platform: "node",
  fixedExtension: false,
  target: "node22",
  dts: true,
  clean: true,
  sourcemap: true,
});
