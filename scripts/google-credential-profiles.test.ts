import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readGoogleCredentials } from "../packages/health-core/src/google-credentials.js";
import { googleAuthConfiguration, reconcileGoogleProfiles } from "./google-credential-profiles.js";

const credentials = readGoogleCredentials({ GEMINI_API_KEY: "fake-primary", GEMINI_API_KEY_1: "fake-backup" });
it("writes secret references, preserves unrelated profiles and cooldowns, and is idempotent", () => {
  const store = { profiles: { "other:keep": { type: "api_key", key: "other-secret" }, "google:legacy": { type: "api_key", provider: "google", key: "legacy-secret" }, "google:clawfit-backup-8": { type: "api_key", key: "removed-slot-secret" } },
    order: { other: ["other:keep"] }, usageStats: { "google:clawfit-primary": { cooldownUntil: 9000 }, "google:clawfit-backup-8": { cooldownUntil: 9000 } }, lastGood: { google: "google:clawfit-backup-8", other: "other:keep" } };
  expect(reconcileGoogleProfiles(store, credentials)).toBe(true);
  expect(reconcileGoogleProfiles(store, credentials)).toBe(false);
  expect(store.profiles).toHaveProperty("other:keep");
  expect(store.profiles).toHaveProperty("google:legacy");
  expect(store.profiles).not.toHaveProperty("google:clawfit-backup-8");
  expect(store.profiles).toHaveProperty("google:clawfit-primary", { type: "api_key", provider: "google", keyRef: { source: "env", provider: "default", id: "GEMINI_API_KEY" } });
  expect(store.usageStats["google:clawfit-primary"]).toEqual({ cooldownUntil: 9000 });
  expect(JSON.stringify(store)).not.toMatch(/fake-primary|fake-backup|removed-slot-secret/);
  expect(store.order).toMatchObject({ google: ["google:clawfit-primary", "google:clawfit-backup-1"], other: ["other:keep"] });
});
it("configures an explicit managed order while preserving unrelated auth settings", () => {
  const auth = googleAuthConfiguration({ profiles: { "other:keep": { provider: "other", mode: "api_key" } }, order: { other: ["other:keep"] }, cooldowns: { billingBackoffHours: 5 } }, credentials);
  expect(auth.order.google).toEqual(["google:clawfit-primary", "google:clawfit-backup-1"]);
  expect(auth.cooldowns).toMatchObject({ billingBackoffHours: 5, rateLimitedProfileRotations: 1 });
  expect(JSON.stringify(auth)).not.toMatch(/fake-primary|fake-backup/);
});
it.each([false, true])("pinned Gateway retries the same model using actual stored profiles; exhausted=%s", async exhausted => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", fileURLToPath(new URL("fixtures/google-credential-replay.mjs", import.meta.url)), ...(exhausted ? ["--exhausted"] : [])], { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 55_000, maxBuffer: 2 * 1024 * 1024 });
  const line = stdout.split("\n").find(value => value.startsWith("CLAWFIT_AUTH_RESULT="));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line!.slice("CLAWFIT_AUTH_RESULT=".length));
  expect(result.configuredProfiles).toBe(3);
  expect(result.storedReferencesOnly).toBe(true);
  expect(result.models).toEqual(["gemini-offline-flash-lite"]);
  expect(result.attemptedSlots).toEqual(exhausted ? ["primary", "backup-1", "backup-2"] : ["primary", "backup-1", "backup-1"]);
  expect(result.succeeded).toBe(!exhausted);
  expect(result.cooledPrimary).toBe(true);
});
