import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { gatewayPaths } from "./gateway-state.js";
import { loadClawFitEnv } from "./load-env.js";
import { inspectHealthReadiness } from "./health-readiness.js";

const names = ["HEALTH_API_URL", "HEALTH_API_OPENCLAW_TOKEN"] as const;
const inherited = Object.fromEntries(names.map(name => [name, process.env[name]]));
// Source values stay inside this process. Output only presence/equality flags.
function sourceFlags(file: string) {
  let values: Record<string, string>;
  try { values = parse(readFileSync(file)); }
  catch { return { readable: false }; }
  return { readable: true, ...Object.fromEntries(names.map(name => [name, {
    present: Boolean(values[name]), matchesEffective: values[name] !== undefined && values[name] === process.env[name],
  }])) };
}
try {
  loadClawFitEnv();
  console.info(`[clawfit-preflight] ${JSON.stringify({ reason: "readiness_context", runtime: process.versions.bun ? "bun" : process.release.name, nodeVersion: process.version,
    hasNodeOptions: Boolean(process.env.NODE_OPTIONS),
    hasProxyConfiguration: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy),
    hasCustomCaConfiguration: Boolean(process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE || process.env.SSL_CERT_DIR),
    explicitEnvSelected: Boolean(process.env.OPENCLAW_ENV_FILE),
    inherited: Object.fromEntries(names.map(name => [name, { present: inherited[name] !== undefined, matchesEffective: inherited[name] !== undefined && inherited[name] === process.env[name] }])),
    protectedEnvironment: sourceFlags(gatewayPaths().envPath),
    repositoryEnvironment: sourceFlags(fileURLToPath(new URL("../.env", import.meta.url))),
  })}`);
  const result = await inspectHealthReadiness(process.env);
  console.info(`[clawfit-preflight] ${JSON.stringify(result)}`);
  process.exitCode = result.reason === "ready" ? 0 : 1;
} catch {
  console.error('[clawfit-preflight] {"reason":"environment_load_failed"}');
  process.exitCode = 1;
}
