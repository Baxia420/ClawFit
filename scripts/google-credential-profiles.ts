import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readGoogleCredentials, type GoogleCredential } from "../packages/health-core/src/google-credentials.js";
import { z } from "zod";
import { OPENCLAW_VERSION } from "./openclaw-configuration.js";

export const profileId = (credential: GoogleCredential) => `google:clawfit-${credential.id}`;
type ProfileStore = {
  profiles: Record<string, unknown>;
  order?: Record<string, string[]>;
  usageStats?: Record<string, unknown>;
  lastGood?: Record<string, string>;
};
type AuthSdk = {
  updateAuthProfileStoreWithLock: (params: { agentDir: string; updater: (store: ProfileStore) => boolean; saveOptions: { syncExternalCli: false; filterExternalAuthProfiles: false } }) => Promise<ProfileStore | null>;
  ensureAuthProfileStoreForLocalUpdate: (agentDir: string) => ProfileStore;
};

export async function loadGoogleAuthSdk(): Promise<AuthSdk> {
  const require = createRequire(new URL("../packages/openclaw-health/package.json", import.meta.url));
  const entry = require.resolve("openclaw/plugin-sdk/provider-auth");
  const root = resolve(dirname(entry), "../..");
  if (JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version !== OPENCLAW_VERSION) throw new Error("Credential setup requires the pinned OpenClaw version.");
  return await import(pathToFileURL(entry).href) as AuthSdk;
}

export function googleAuthConfiguration(existing: unknown, credentials: readonly GoogleCredential[]) {
  if (!credentials.length) throw new Error("GEMINI_API_KEY is required for Gateway credential profiles.");
  const auth = z.object({ profiles: z.record(z.string(), z.unknown()).optional(), order: z.record(z.string(), z.array(z.string())).optional(), cooldowns: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(existing ?? {});
  const profiles = Object.fromEntries(Object.entries(auth.profiles ?? {}).filter(([id]) => !id.startsWith("google:clawfit-")));
  for (const credential of credentials) profiles[profileId(credential)] = { provider: "google", mode: "api_key" };
  // This pinned host's rotation limit applies before a model fallback. With
  // fallbacks disabled it can exhaust the eligible pool; the plugin's existing
  // model-start and turn-time limits still apply. Do not promise a two-call cap.
  return { ...auth, profiles, order: { ...auth.order, google: credentials.map(profileId) },
    cooldowns: { ...auth.cooldowns, rateLimitedProfileRotations: 1, overloadedProfileRotations: 1 } };
}

export function reconcileGoogleProfiles(store: ProfileStore, credentials: readonly GoogleCredential[]): boolean {
  const before = JSON.stringify(store);
  const ids = credentials.map(profileId);
  for (const id of Object.keys(store.profiles)) {
    if (!id.startsWith("google:clawfit-") || ids.includes(id)) continue;
    delete store.profiles[id];
    if (store.usageStats) delete store.usageStats[id];
  }
  for (const credential of credentials) {
    store.profiles[profileId(credential)] = { type: "api_key", provider: "google",
      keyRef: { source: "env", provider: "default", id: credential.envName } };
  }
  // Per-agent order overrides global config, so keep both synchronized.
  store.order = { ...store.order, google: ids };
  if (store.lastGood?.google && !ids.includes(store.lastGood.google)) delete store.lastGood.google;
  return JSON.stringify(store) !== before;
}

export async function installGoogleProfiles(agentDir: string, credentials: readonly GoogleCredential[]): Promise<void> {
  const sdk = await loadGoogleAuthSdk();
  const result = await sdk.updateAuthProfileStoreWithLock({ agentDir,
    saveOptions: { syncExternalCli: false, filterExternalAuthProfiles: false },
    updater: store => reconcileGoogleProfiles(store, credentials) });
  if (!result) throw new Error("Gateway credential profile update did not complete.");
}

export async function validateGoogleProfiles(config: unknown, agentDir: string, env = process.env): Promise<number> {
  const credentials = readGoogleCredentials(env);
  if (!credentials.length) throw new Error("Missing Google credentials.");
  const parsed = z.object({
    models: z.object({ providers: z.object({ google: z.object({ apiKey: z.never().optional(), headers: z.record(z.string(), z.string()).optional() }).passthrough() }) }),
    auth: z.object({ order: z.object({ google: z.array(z.string()) }), cooldowns: z.object({ rateLimitedProfileRotations: z.literal(1) }) }),
  }).passthrough().parse(config);
  if (Object.keys(parsed.models.providers.google.headers ?? {}).some(name => /^(authorization|x-goog-api-key)$/i.test(name))) throw new Error("Provider headers must not override credential profiles.");
  const sdk = await loadGoogleAuthSdk();
  const store = sdk.ensureAuthProfileStoreForLocalUpdate(agentDir);
  const expected = credentials.map(profileId);
  if (JSON.stringify(parsed.auth.order.google) !== JSON.stringify(expected) || JSON.stringify(store.order?.google) !== JSON.stringify(expected)) throw new Error("Google credential routing is out of date. Run models:configure.");
  for (const credential of credentials) {
    const stored = z.object({ type: z.literal("api_key"), provider: z.literal("google"), key: z.never().optional(), keyRef: z.object({ source: z.literal("env"), provider: z.literal("default"), id: z.literal(credential.envName) }) }).safeParse(store.profiles[profileId(credential)]);
    if (!stored.success) throw new Error("Google credential profile does not match its protected environment reference.");
  }
  return credentials.length;
}
