// `pnpm run bench`: run the benchmark from the command line (bench/run.ts).
import { main } from "./run";

process.exitCode = await main(process.argv.slice(2));
