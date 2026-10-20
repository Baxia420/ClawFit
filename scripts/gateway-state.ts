import { randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import JSON5 from "json5";
import { parse } from "dotenv";
import { z } from "zod";
import { parseAllowlist } from "./openclaw-configuration.js";
import { GOOGLE_KEY_ENV_NAMES, readGoogleCredentials } from "../packages/health-core/src/google-credentials.js";

export function gatewayPaths(env = process.env) {
  const stateDir = resolve(env.OPENCLAW_STATE_DIR ?? resolve(homedir(), ".openclaw"));
  return { stateDir, envPath: resolve(stateDir, ".env"), configPath: resolve(env.OPENCLAW_CONFIG_PATH ?? resolve(stateDir, "openclaw.json")) };
}

export async function readGatewayConfig(path = gatewayPaths().configPath): Promise<Record<string, unknown>> {
  try { return z.record(z.string(), z.unknown()).parse(JSON5.parse(await readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("Cannot parse Gateway config. Validate it before running setup."); }
}

export function reconcileGatewayToken(config: Record<string, unknown>, values: Record<string, string>, env = process.env): string {
  const gateway = z.object({ auth: z.object({ mode: z.string().optional(), token: z.unknown().optional() }).passthrough().optional() }).passthrough().parse(config.gateway ?? {});
  if (gateway.auth?.mode && gateway.auth.mode !== "token") throw new Error("Existing Gateway authentication is not token mode; setup will not replace it.");
  const input = gateway.auth?.token;
  let configured: string | undefined;
  if (typeof input === "string") {
    const match = /^\$\{([A-Z0-9_]+)\}$/.exec(input);
    configured = match ? values[match[1]!] ?? env[match[1]!] : input;
    if (match && !configured) throw new Error("Existing Gateway token environment reference cannot be resolved; credentials were preserved.");
  } else if (input !== undefined) {
    const ref = z.object({ source: z.literal("env"), id: z.string(), provider: z.string().optional() }).safeParse(input);
    if (!ref.success) throw new Error("Existing Gateway token uses an external secret provider; setup will not replace it.");
    configured = values[ref.data.id] ?? env[ref.data.id];
    if (!configured) throw new Error("Existing Gateway token reference cannot be resolved; credentials were preserved.");
  }
  return z.string().min(24).parse(configured || values.OPENCLAW_GATEWAY_TOKEN || env.OPENCLAW_GATEWAY_TOKEN || randomBytes(32).toString("hex"));
}

export async function ensureGatewayDirectories(stateDir = gatewayPaths().stateDir): Promise<void> {
  if (process.platform !== "win32" && process.getuid?.() === 0) throw new Error("Run setup as the Gateway service user, not root. Use sudo -u clawfit -H.");
  for (const suffix of ["", "agents", "agents/main", "agents/main/agent", "agents/main/sessions", "workspace"]) {
    const path = resolve(stateDir, suffix);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Gateway state directories must be real directories owned by the service user.");
    if (process.getuid && stat.uid !== process.getuid()) throw new Error("Gateway state directory has a different owner. Repair only the affected directory as documented.");
    await access(path, constants.W_OK | constants.X_OK);
  }
}

export async function syncGatewayEnvironment(env = process.env): Promise<void> {
  const paths = gatewayPaths(env);
  await ensureGatewayDirectories(paths.stateDir);
  const config = await readGatewayConfig(paths.configPath);
  if (config.$include) throw new Error("Included Gateway configuration requires manual credential reconciliation; setup did not change it.");
  let original = "";
  try { original = await readFile(paths.envPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const values = parse(original);
  const required = ["GEMINI_API_KEY", "HEALTH_API_OPENCLAW_TOKEN", "HEALTH_API_URL"];
  const names = [...new Set([...required, ...GOOGLE_KEY_ENV_NAMES, "CLAWFIT_WHATSAPP_ALLOW_FROM", "CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS", "APP_TIMEZONE"])];
  for (const name of names) {
    if (!values[name]?.trim() && env[name]?.trim()) values[name] = env[name]!;
  }
  parseAllowlist(values.CLAWFIT_WHATSAPP_ALLOW_FROM, "senders");
  parseAllowlist(values.CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS, "groups");
  const missing = required.filter(name => !values[name]?.trim());
  if (missing.length) throw new Error(`Missing protected Gateway variables: ${missing.join(", ")}`);
  readGoogleCredentials(values);
  values.OPENCLAW_GATEWAY_TOKEN = reconcileGatewayToken(config, values, env);
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  for (const name of [...names, "OPENCLAW_GATEWAY_TOKEN"]) {
    if (values[name] === undefined) continue;
    if (/[\r\n]/.test(values[name]!)) throw new Error(`Multiline ${name} is not supported in a systemd EnvironmentFile.`);
    const replacement = `${name}=${JSON.stringify(values[name])}`;
    const indexes = lines.flatMap((line, i) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line) ? [i] : []);
    if (indexes.length) {
      lines[indexes[0]!] = replacement;
      for (const i of indexes.slice(1)) lines[i] = "";
    } else lines.push(replacement);
    env[name] = values[name];
  }
  const next = `${lines.filter(line => line.trim()).join("\n")}\n`;
  if (next !== original) {
    if (original) await writeFile(`${paths.envPath}.clawfit-backup`, original, { mode: 0o600, flag: "wx" }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const temporary = `${paths.envPath}.clawfit-${randomBytes(6).toString("hex")}`;
    await writeFile(temporary, next, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, paths.envPath);
  }
  if (process.platform !== "win32") await chmod(paths.envPath, 0o600);
}
