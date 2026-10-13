// OpenClaw's compile-cache launcher can respawn even with NO_RESPAWN set.
// Node --import is inherited through process.execArgv by that real launcher.
import { createRequire } from "node:module";
import { isMainThread } from "node:worker_threads";
import path from "node:path";
import { installRuntimeCompatibility } from "./openclaw-runtime-compat.mjs";

// The pinned gateway also starts auth/audit/compaction workers and forked jobs.
// They inherit Node flags, but their entry is not the CLI and must stay intact.
if (isMainThread && process.argv[1] && path.basename(process.argv[1]) === "openclaw.mjs") {
  const require = createRequire(process.argv[1]);
  installRuntimeCompatibility(path.dirname(require.resolve("./package.json")));
}
