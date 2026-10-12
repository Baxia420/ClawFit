// OpenClaw's compile-cache launcher can respawn even with NO_RESPAWN set.
// Node --import is inherited through process.execArgv by that real launcher.
import { createRequire } from "node:module";
import path from "node:path";
import { installRuntimeCompatibility } from "./openclaw-runtime-compat.mjs";

const require = createRequire(process.argv[1]);
installRuntimeCompatibility(path.dirname(require.resolve("./package.json")));
