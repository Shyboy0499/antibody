import { defineConfig } from "tsdown";

// Two builds.
//
// The library: src/index.ts to lib/ as ESM with type declarations. platform
// "node" would default fixedExtension to true and emit .mjs and .d.mts;
// package.json's `exports` points at lib/index.js and lib/index.d.ts, so the
// build names its files the way the package type does.
//
// The executable: src/bin.ts bundled into one dependency-free file,
// dist/antibody.mjs, which is committed. A Claude Code plugin is installed by
// cloning its repository, with no build step, so its hooks and MCP server run
// this file as it is in git. CI rebuilds it and fails if the committed copy
// differs.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    outDir: "lib",
    format: ["esm"],
    platform: "node",
    fixedExtension: false,
    target: "node22",
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: { antibody: "src/bin.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    fixedExtension: true,
    target: "node22",
    dts: false,
    clean: true,
    sourcemap: false,
  },
]);
