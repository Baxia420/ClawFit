import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadClawFitEnv } from "./load-env.js";
import { ensureGatewayDirectories, readGatewayConfig } from "./gateway-state.js";
import { runOpenClaw } from "./openclaw-cli.js";
import { validateGatewaySearch, GOOGLE_API, GOOGLE_BASE_URL, OPENCLAW_VERSION, parseAllowlist } from "./openclaw-configuration.js";
import { inspectHealthReadiness } from "./health-readiness.js";

loadClawFitEnv();
if (process.argv.includes("--live") && process.argv.includes("--before-restart")) throw new Error("Run --live only after restarting the Gateway.");
let failures = 0;
async function check(label: string, action: () => unknown | Promise<unknown>) {
  try { await action(); console.log(`PASS ${label}`); }
  catch { failures++; console.error(`FAIL ${label}. Check local configuration/logs; diagnostic values are hidden.`); }
}
await check("Pinned OpenClaw version", () => {
  const version = runOpenClaw(["--version"], { capture: true }).stdout?.toString() ?? "";
  if (!version.includes(OPENCLAW_VERSION)) throw new Error("version");
});
await check("Service-user state directory ownership and write access", () => ensureGatewayDirectories());
await check("Built health plugin validates", () => runOpenClaw(["plugins", "validate", "--root", resolve("packages/openclaw-health"), "--entry", "dist/index.js"], { capture: true }));
await check("OpenClaw configuration validates", () => runOpenClaw(["config", "validate"], { capture: true }));
const config = await readGatewayConfig();
await check("Google-native transport and registered primary/fallbacks", () => {
  const parsed = z.object({
    models: z.object({ providers: z.object({ google: z.object({ api: z.literal(GOOGLE_API), baseUrl: z.literal(GOOGLE_BASE_URL),
      models: z.array(z.object({ id: z.string(), api: z.literal(GOOGLE_API), baseUrl: z.literal(GOOGLE_BASE_URL) })) }) }) }),
    agents: z.object({ defaults: z.object({ model: z.object({ primary: z.string(), fallbacks: z.array(z.string()).optional() }) }) }),
  }).parse(config);
  const ids = new Set(parsed.models.providers.google.models.map(m => `google/${m.id}`));
  if (![parsed.agents.defaults.model.primary, ...(parsed.agents.defaults.model.fallbacks ?? [])].every(id => ids.has(id))) throw new Error("registry");
});
await check("Canonical gateway authentication and loopback binding", () => {
  z.object({ gateway: z.object({ mode: z.literal("local"), bind: z.literal("loopback"), auth: z.object({ mode: z.literal("token"), token: z.literal("${OPENCLAW_GATEWAY_TOKEN}") }), remote: z.object({ token: z.literal("${OPENCLAW_GATEWAY_TOKEN}") }) }) }).parse(config);
  z.string().min(24).parse(process.env.OPENCLAW_GATEWAY_TOKEN);
});
await check("Sender/group allowlists and restricted health tools", async () => {
  const expected = z.object({ healthTools: z.array(z.string()) }).parse(JSON.parse(await readFile("openclaw/policy.json", "utf8")));
  const parsed = z.object({ tools: z.object({ profile: z.literal("minimal"), alsoAllow: z.array(z.string()), deny: z.array(z.string()) }),
    channels: z.object({ whatsapp: z.object({ dmPolicy: z.literal("allowlist"), allowFrom: z.array(z.string()).min(1), groupAllowFrom: z.array(z.string()).min(1), groupPolicy: z.enum(["allowlist", "disabled"]), groups: z.record(z.string(), z.unknown()).optional() }) }) }).parse(config);
  const searchTools = validateGatewaySearch(config);
  if (JSON.stringify([...parsed.tools.alsoAllow].sort()) !== JSON.stringify([...expected.healthTools, ...searchTools].sort())) throw new Error("tools");
  if (!["group:runtime", "group:fs", "browser", "web_fetch"].every(t => parsed.tools.deny.includes(t))) throw new Error("deny");
  const senders = parseAllowlist(process.env.CLAWFIT_WHATSAPP_ALLOW_FROM, "senders");
  const groups = parseAllowlist(process.env.CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS, "groups");
  const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const wa = parsed.channels.whatsapp;
  if (!same(senders, wa.allowFrom) || !same(senders, wa.groupAllowFrom)) throw new Error("senders");
  if (groups.length ? wa.groupPolicy !== "allowlist" || !same(groups, Object.keys(wa.groups ?? {})) : wa.groupPolicy !== "disabled") throw new Error("groups");
});
await check("Background filesystem memory flush disabled", () => {
  z.object({ agents: z.object({ defaults: z.object({ compaction: z.object({ memoryFlush: z.object({ enabled: z.literal(false) }) }) }) }) }).parse(config);
});
await check("Health API readiness; nutrition estimator configured (generation not tested)", async () => {
  const result = await inspectHealthReadiness(process.env);
  console.info(`[clawfit-preflight] ${JSON.stringify(result)}`);
  if (result.reason !== "ready") throw new Error("Health API readiness check failed");
});
if (!process.argv.includes("--before-restart")) {
  await check("Authenticated gateway RPC", () => runOpenClaw(["gateway", "status", "--require-rpc", "--json"], { capture: true }));
  await check("WhatsApp channel connected", () => {
    const result = runOpenClaw(["channels", "status", "--probe", "--json"], { capture: true });
    const state = z.object({ channels: z.record(z.string(), z.unknown()).optional(), channelAccounts: z.record(z.string(), z.array(z.object({ connected: z.boolean().optional(), running: z.boolean().optional() }).passthrough())).optional() }).parse(JSON.parse(result.stdout?.toString() ?? "{}"));
    const channel = z.object({ connected: z.boolean().optional(), running: z.boolean().optional() }).safeParse(state.channels?.whatsapp);
    const accounts = state.channelAccounts?.whatsapp ?? [];
    if (!(channel.success && channel.data.connected === true) && !accounts.some(a => a.connected === true && a.running !== false)) throw new Error("channel");
  });
}
if (process.argv.includes("--live")) {
  if (failures) console.error("SKIP live model request: fix preflight failures first.");
  else await check("Real Google generation through Gateway (no message delivery)", () => {
    const result = runOpenClaw(["agent", "--agent", "main", "--session-id", `clawfit-preflight-${randomUUID()}`, "--message", "Reply with CLAWFIT_PREFLIGHT_OK. Do not call any tools.", "--timeout", "60", "--json"], { capture: true });
    const output = z.object({ result: z.record(z.string(), z.unknown()).optional(), meta: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(JSON.parse(result.stdout?.toString() ?? "{}"));
    const body = output.result ?? output;
    const meta = z.object({ transport: z.string().optional(), fallbackFrom: z.string().optional(), agentMeta: z.object({ provider: z.literal("google"), model: z.string() }) }).parse(body.meta ?? output.meta);
    if (meta.transport === "embedded" || meta.fallbackFrom) throw new Error("embedded fallback is not Gateway success");
    const payloads = z.array(z.object({ text: z.string().optional() }).passthrough()).parse(body.payloads);
    if (!payloads.some(p => p.text?.includes("CLAWFIT_PREFLIGHT_OK"))) throw new Error("reply");
  });
} else console.log("PENDING real Gateway generation: rerun with --live when ready for one model request. WhatsApp read-only health-tool acceptance remains a manual test.");
console.log("Render nutrition-model environment must be checked separately; changing this Gateway does not change Render.");
process.exitCode = failures ? 1 : 0;
