// Exercise the real global-style launcher and its compile-cache respawn before
// entering the full offline dispatcher replay. Every state file is temporary.
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../packages/openclaw-health/package.json", import.meta.url));
const root = path.dirname(path.dirname(path.dirname(require.resolve("openclaw/plugin-sdk/plugin-runtime"))));
const directory = await mkdtemp(path.join(tmpdir(), "clawfit-cli-replay-"));
try {
 const plugin = path.join(directory, "cli-plugin");
 const bin = path.join(directory, "bin");
 await mkdir(plugin); await mkdir(bin);
 await symlink(path.join(root, "openclaw.mjs"), path.join(bin, "openclaw"));
 const replay = fileURLToPath(new URL("whatsapp-burst-replay.mjs", import.meta.url));
 await writeFile(path.join(plugin, "openclaw.plugin.json"), JSON.stringify({ id: "clawfit-replay-cli", configSchema: { type: "object", properties: {} } }));
 const stockDispatcher = path.join(root, "dist/dispatch-DnzGTpPs.js");
 await writeFile(path.join(plugin, "index.js"), `export default { id: "clawfit-replay-cli", register(api) { api.registerCli(({program}) => program.command("clawfit-replay").option("--seed-cache").option("--launcher-compat").option("--album").option("--three").option("--attempt-writes").allowUnknownOption().allowExcessArguments().action(async options => { if(options.seedCache) { await import(${JSON.stringify(stockDispatcher)}); console.log("STOCK_CACHE_SEEDED"); } else await import(${JSON.stringify(replay)}); }), { commands: ["clawfit-replay"] }); } };`);
 await writeFile(path.join(directory, "openclaw.json"), JSON.stringify({ plugins: { allow: ["clawfit-replay-cli"], slots: { memory: "none" }, load: { paths: [plugin] } }, agents: { defaults: { workspace: directory, skipBootstrap: true } } }));
 const execute = promisify(execFile);
 const options = {
  env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"), NODE_COMPILE_CACHE: path.join(directory, "cache"), OPENCLAW_NO_RESPAWN: "1" },
  timeout: 55_000, maxBuffer: 4 * 1024 * 1024,
 };
 const guard = fileURLToPath(new URL("offline-network.mjs", import.meta.url));
 // First populate this SAME compile cache with the stock dispatcher. The new
 // hook must still take effect when Node has cached the old runtime already.
 const seeded = await execute(process.execPath, ["--import", guard, path.join(root, "openclaw.mjs"), "clawfit-replay", "--seed-cache"], options);
 if (!seeded.stdout.includes("STOCK_CACHE_SEEDED")) throw new Error("Stock runtime cache was not seeded");
 const { stdout } = await execute(process.execPath, ["--import", guard, fileURLToPath(new URL("../openclaw-gateway.mjs", import.meta.url)), "clawfit-replay", "--launcher-compat", "--album", "--three", "--attempt-writes"], options);
 const resultLine = stdout.split("\n").find(line => line.startsWith("CLAWFIT_BURST_RESULT="));
 if (!resultLine) throw new Error("Real CLI replay did not return a result");
 console.log(`CLAWFIT_CLI_RESULT=${JSON.stringify({ ...JSON.parse(resultLine.slice("CLAWFIT_BURST_RESULT=".length)), stockCacheSeeded: true, readyCount: stdout.match(/"reason":"compatibility_ready"/g)?.length ?? 0, dispatcherPatched: stdout.includes('"reason":"dispatcher_hook_applied"') })}`);
} finally { await rm(directory, { recursive: true, force: true }); }
