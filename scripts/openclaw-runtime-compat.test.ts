import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(new URL("../packages/openclaw-health/package.json", import.meta.url));
const runtimeRoot = path.dirname(path.dirname(path.dirname(require.resolve("openclaw/plugin-sdk/plugin-runtime"))));
const { checkRuntimeCompatibility } = await import(pathToFileURL(fileURLToPath(new URL("openclaw-runtime-compat.mjs", import.meta.url))).href);

it.skipIf(process.platform === "win32")("launches the existing CLI entry without relocating its state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clawfit-launcher-"));
  try {
    await symlink(path.join(runtimeRoot, "openclaw.mjs"), path.join(directory, "openclaw"));
    const options = { env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"), OPENCLAW_NO_RESPAWN: "1" }, timeout: 30_000 };
    const launcher = fileURLToPath(new URL("openclaw-gateway.mjs", import.meta.url));
    const execute = promisify(execFile);
    expect((await execute(process.execPath, [launcher, "--check"], options)).stdout).toContain("compatibility verified");
    expect((await execute(process.execPath, [launcher, "--version"], options)).stdout).toContain("2026.7.1-2");
    const { stdout } = await execute(process.execPath, [launcher, "--help"], {
      ...options, env: { ...options.env, NODE_COMPILE_CACHE: path.join(directory, "compile-cache") },
    });
    // --version exits before the real launcher's cache-respawn path. --help
    // executes that path: both parent AND child must install the compatibility.
    expect(stdout.match(/"reason":"compatibility_ready"/g)).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("accepts the pinned runtime and refuses changed code even with the same version", async () => {
  expect(() => checkRuntimeCompatibility(runtimeRoot)).not.toThrow();
  const root = await mkdtemp(path.join(tmpdir(), "clawfit-runtime-check-"));
  try {
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.7.1-2" }));
    await writeFile(path.join(root, "dist/dispatch-DnzGTpPs.js"), "unexpected runtime code");
    expect(() => checkRuntimeCompatibility(root)).toThrow("dispatch bundle changed");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.8.1" }));
    expect(() => checkRuntimeCompatibility(root)).toThrow("requires OpenClaw 2026.7.1-2");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("wires both the first upgrade and a later rollback to the checked-out service unit", async () => {
  const read = (name: string) => readFile(new URL(`../deploy/openclaw/${name}`, import.meta.url), "utf8");
  const [unit, repair, redeploy] = await Promise.all([read("clawfit-openclaw.service"), read("repair-state.sh"), read("redeploy.sh")]);
  expect(unit).toContain("ExecStart=/usr/bin/env node /home/clawfit/app/scripts/openclaw-gateway.mjs gateway run");
  for (const script of [repair, redeploy]) {
    expect(script).toContain('install -m 644 "$APP_DIR/deploy/openclaw/clawfit-openclaw.service" /etc/systemd/system/clawfit-openclaw.service');
    expect(script).toContain("systemctl daemon-reload");
  }
  expect(repair.indexOf('"$APP_DIR/scripts/openclaw-gateway.mjs" --check')).toBeLessThan(repair.indexOf("install -m 644"));
  expect(redeploy.indexOf("install -m 644")).toBeLessThan(redeploy.indexOf("systemctl start clawfit-openclaw"));
});
