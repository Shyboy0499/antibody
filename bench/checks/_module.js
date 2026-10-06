// The acceptance checks run with the agent's worktree as the working
// directory, and load its modules from there.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const load = (file) =>
  import(pathToFileURL(join(process.cwd(), file)).href);
