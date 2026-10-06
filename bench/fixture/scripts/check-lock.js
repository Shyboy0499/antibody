// Refuses to run with a lockfile that does not match package.json, the way a
// frozen-lockfile install does in CI.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const { dependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
const digest = createHash("sha256")
  .update(JSON.stringify(dependencies))
  .digest("hex");
let locked = "";
try {
  locked = JSON.parse(readFileSync("deps.lock", "utf8")).digest;
} catch {
  // A missing or unreadable lockfile is out of date too.
}
if (locked !== digest) {
  console.error(
    ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because deps.lock is not up to date with package.json',
  );
  process.exit(1);
}
