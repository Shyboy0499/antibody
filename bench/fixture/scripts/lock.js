// Records the dependencies package.json declares in deps.lock, as a package
// manager's lockfile would.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const { dependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
const digest = createHash("sha256")
  .update(JSON.stringify(dependencies))
  .digest("hex");
writeFileSync(
  "deps.lock",
  `${JSON.stringify({ dependencies, digest }, null, 2)}\n`,
);
console.log("deps.lock updated");
