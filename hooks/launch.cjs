"use strict";
// Plain CommonJS so a project's pinned older Node (mise, asdf, nvm) can still read it:
// dist/antibody.mjs needs 22.13 and would crash out of sight, so on an older Node
// this hands over to ANTIBODY_NODE, or explains on stderr and exits 0.
// Bare module names: the node: prefix needs Node 14.18 or 16.
const { spawnSync } = require("child_process");
const { join } = require("path");
const { pathToFileURL } = require("url");

const MINIMUM = [22, 13];
const bundle = join(__dirname, "..", "dist", "antibody.mjs");

function supported(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > MINIMUM[0] || (major === MINIMUM[0] && minor >= MINIMUM[1]);
}

function plan(version, env) {
  if (supported(version)) return { kind: "import" };
  if (env.ANTIBODY_NODE) return { kind: "spawn", node: env.ANTIBODY_NODE };
  return {
    kind: "skip",
    message: `antibody: Node ${version} is older than ${MINIMUM.join(".")}; set ANTIBODY_NODE to a newer node binary\n`,
  };
}

function run() {
  const next = plan(process.versions.node, process.env);
  if (next.kind === "import") return import(pathToFileURL(bundle).href);
  if (next.kind === "skip") {
    process.stderr.write(next.message);
    return;
  }
  const child = spawnSync(next.node, [bundle, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  if (child.error) {
    process.stderr.write(
      `antibody: cannot run ANTIBODY_NODE: ${child.error.message}\n`,
    );
    return;
  }
  process.exitCode = child.status === null ? 0 : child.status;
}

if (require.main === module) run();

module.exports = { supported, plan };
