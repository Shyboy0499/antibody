"use strict";
// The plugin's hooks and MCP server start here instead of at dist/antibody.mjs.
//
// Claude Code runs them with whatever `node` comes first on PATH in the
// session's directory. A project that pins its Node through mise, asdf, nvm or
// volta puts its own version first, and dist/antibody.mjs crashes on anything
// older than 22.13 with a stack trace the agent never sees, so the plugin looks
// installed and does nothing. This file is plain CommonJS that any Node still
// in use can read: on a new enough Node it loads the bundle in-process, on an
// older one it hands the same arguments and stdio to the Node named by
// ANTIBODY_NODE, and without one it says why on stderr and exits 0, because a
// hook never breaks the session.
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const MINIMUM = [22, 13];
const bundle = join(__dirname, "..", "dist", "antibody.mjs");

/** Whether a `process.versions.node` string can run the bundle. */
function supported(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > MINIMUM[0] || (major === MINIMUM[0] && minor >= MINIMUM[1]);
}

/** How to start the bundle from this Node: in-process, under another Node, or not at all. */
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
