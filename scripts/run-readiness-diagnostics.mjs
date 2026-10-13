// Read approved diagnostic sources from git without checking out or deploying.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Supply the reviewed diagnostics commit SHA.");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const directory = await mkdtemp(path.join(tmpdir(), "clawfit-readiness-"));
try {
  const read = file => execFileSync("git", ["show", `${sha}:scripts/${file}`], { encoding: "utf8", cwd: root });
  let diagnostic = read("health-readiness-diagnose.ts");
  for (const module of ["gateway-state", "load-env"]) diagnostic = diagnostic.replace(JSON.stringify(`./${module}.js`), JSON.stringify(pathToFileURL(path.join(root, "scripts", `${module}.ts`)).href));
  diagnostic = diagnostic.replace('"./health-readiness.js"', '"./health-readiness.mts"');
  diagnostic = diagnostic.replace('fileURLToPath(new URL("../.env", import.meta.url))', `fileURLToPath(new URL(${JSON.stringify(pathToFileURL(path.join(root, ".env")).href)}))`);
  await writeFile(path.join(directory, "health-readiness.mts"), read("health-readiness.ts"), { mode: 0o600 });
  await writeFile(path.join(directory, "health-readiness-diagnose.mts"), diagnostic, { mode: 0o600 });
  await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  const execute = promisify(execFile);
  const entry = path.join(directory, "health-readiness-diagnose.mts");
  for (const launch of [
    { name: "pnpm_tsx", command: "pnpm", args: ["exec", "tsx", entry] },
    { name: "direct_node", command: process.execPath, args: ["--import", "tsx", entry] },
  ]) {
    let stdout = "";
    try { stdout = (await execute(launch.command, launch.args, { cwd: root, timeout: 65_000, maxBuffer: 256 * 1024 })).stdout; }
    catch (error) { stdout = typeof error.stdout === "string" ? error.stdout : ""; process.exitCode = 1; }
    console.info(`[clawfit-preflight] ${JSON.stringify({ reason: "diagnostic_launch", launch: launch.name })}`);
    const lines = stdout.split("\n").filter(line => line.startsWith("[clawfit-preflight] "));
    // Launch errors can contain file paths or inherited sensitive context.
    // Report only the bounded diagnostics emitted by the reviewed helper.
    if (!lines.length) console.info('[clawfit-preflight] {"reason":"diagnostic_launch_failed"}');
    else for (const line of lines) console.info(line);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
