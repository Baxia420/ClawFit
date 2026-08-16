import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

type RunOptions = {
  capture?: boolean;
  allowFailure?: boolean;
};

export function runOpenClaw(args: string[], options: RunOptions = {}) {
  const command = process.platform === "win32" ? process.execPath : "openclaw";
  const commandArgs = process.platform === "win32" ? [resolveWindowsOpenClawEntry(), ...args] : args;
  const result = spawnSync(command, commandArgs, {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`OpenClaw command failed with exit code ${result.status ?? 1}: ${args.slice(0, 2).join(" ")}`);
  }

  return result;
}

export function getOpenClawJson<T>(path: string): T | undefined {
  const result = runOpenClaw(["config", "get", path, "--json"], { capture: true, allowFailure: true });
  if (result.status !== 0 || !result.stdout) return undefined;
  return JSON.parse(result.stdout.toString()) as T;
}

function resolveWindowsOpenClawEntry() {
  const override = process.env.OPENCLAW_CLI_ENTRY;
  if (override) return override;

  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    if (!pathEntry) continue;
    const globalEntry = join(pathEntry, "node_modules", "openclaw", "openclaw.mjs");
    if (existsSync(globalEntry)) return globalEntry;

    if (/[/\\]\.bin$/i.test(pathEntry)) {
      const localEntry = join(dirname(pathEntry), "openclaw", "openclaw.mjs");
      if (existsSync(localEntry)) return localEntry;
    }
  }

  throw new Error("Could not locate openclaw.mjs on PATH. Reinstall OpenClaw or set OPENCLAW_CLI_ENTRY.");
}
