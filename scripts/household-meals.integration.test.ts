import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "node:module";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { createApp } from "../apps/api/src/create-app.js";
import { DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID, HealthRepository, schema } from "../packages/db/src/index.js";
import type { HealthDatabase } from "../packages/db/src/client.js";
import { derivePendingMealScope } from "../packages/openclaw-health/src/health-client.js";
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { drizzle } = require("drizzle-orm/pglite");
const token = "household-integration-token-at-least-24-chars";
const group = "120363000000000000@g.us";
const senderA = "+60111111111", senderB = "+60222222222";
const scope = (sender: string) => derivePendingMealScope({ messageChannel: "whatsapp", requesterSenderId: sender });
const headers = (sender: string, target?: string) => ({ authorization: `Bearer ${token}`, "x-clawfit-sender-provider": "whatsapp", "x-clawfit-sender-id": sender, "x-clawfit-conversation-id": group, ...(target ? { "x-clawfit-meal-for": target } : {}) });
const meal = { label: "Test meal", calories: { best: 400, low: 350, high: 450 }, macros: { proteinG: 30, carbsG: 40, fatG: 13, fiberG: 2 }, items: [], confidence: "medium", uncertaintyReasons: [], source: "photo", occurredAt: "2026-10-12T05:00:00Z", idempotencyKey: "household-meal-test", rawUserText: "Log this for my partner" };
let pg: PGlite;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
 pg = new PGlite();
 const migrations = fileURLToPath(new URL("../packages/db/drizzle", import.meta.url));
 for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort()) await pg.exec((await readFile(`${migrations}/${file}`, "utf8")).replaceAll("--> statement-breakpoint", ""));
 const repository = new HealthRepository(drizzle(pg, { schema }) as HealthDatabase) as unknown as Parameters<typeof createApp>[0]["repository"];
 await pg.query("UPDATE users SET display_name='Mahin' WHERE id=$1", [DEFAULT_PRIMARY_USER_ID]);
 await pg.query("UPDATE users SET display_name='Cici' WHERE id=$1", [DEFAULT_PARTNER_USER_ID]);
 await repository.linkExternalIdentity({ userId: DEFAULT_PRIMARY_USER_ID, provider: "whatsapp", externalIdentifier: senderA });
 await repository.linkExternalIdentity({ userId: DEFAULT_PARTNER_USER_ID, provider: "whatsapp", externalIdentifier: senderB });
 app = createApp({ repository, openclawToken: token, allowedGroupIds: [group], logger: false });
});
beforeEach(async () => { await pg.exec("DELETE FROM pending_meal_estimates; DELETE FROM meals; UPDATE users SET active=true"); });
afterAll(async () => { await app.close(); await pg.close(); });

it.each([
 [senderA, "Cici", DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID],
 [senderB, "Mahin", DEFAULT_PRIMARY_USER_ID, DEFAULT_PARTNER_USER_ID],
 [senderA, "Athirah", DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID],
 [senderB, "Jobayer", DEFAULT_PRIMARY_USER_ID, DEFAULT_PARTNER_USER_ID],
])("logs for an explicitly named partner in either direction: %s -> %s", async (sender, target, recipient, actor) => {
 const response = await app.inject({ method: "POST", url: "/v1/meals", headers: headers(sender!, target), payload: meal });
 expect(response.statusCode, response.body).toBe(201);
 expect(response.json().userId).toBe(recipient);
 expect(JSON.parse(response.json().rawUserText)).toMatchObject({ recordedByUserId: actor, forUserId: recipient });
 expect(JSON.parse(decodeURIComponent(String(response.headers["x-clawfit-meal-recipient"])))).toMatchObject({ userId: recipient });
 await app.inject({ method: "POST", url: "/v1/meals", headers: headers(sender!, target), payload: meal });
 expect((await pg.query("SELECT count(*)::int AS n FROM meals")).rows[0]).toMatchObject({ n: 1 });
});

it("keeps a delegated draft in its creator's scope and confirms it without changing recipient on a plain yes", async () => {
 const created = await app.inject({ method: "POST", url: "/v1/meals/pending", headers: headers(senderA, "Cici"), payload: { ...meal, scopeKey: scope(senderA) } });
 expect(created.statusCode, created.body).toBe(201);
 expect((await pg.query("SELECT count(*)::int AS n FROM meals")).rows[0]).toMatchObject({ n: 0 });
 const latest = await app.inject({ method: "GET", url: `/v1/meals/pending/latest?scopeKey=${scope(senderA)}`, headers: headers(senderA) });
 expect(latest.json().pending.id).toBe(created.json().id);
 const confirmation = { method: "POST" as const, url: `/v1/meals/pending/${created.json().id}/confirm`, headers: headers(senderA), payload: { scopeKey: scope(senderA) } };
 const saved = await app.inject(confirmation);
 expect(saved.statusCode, saved.body).toBe(200);
 expect(saved.json().userId).toBe(DEFAULT_PARTNER_USER_ID);
 expect(JSON.parse(saved.json().rawUserText).householdConfirmation).toMatchObject({ confirmedByUserId: DEFAULT_PRIMARY_USER_ID, forUserId: DEFAULT_PARTNER_USER_ID });
 expect(JSON.parse(decodeURIComponent(String(saved.headers["x-clawfit-meal-recipient"])))).toMatchObject({ displayName: "Cici" });
 expect((await app.inject(confirmation)).json().id).toBe(saved.json().id);
 expect((await pg.query("SELECT count(*)::int AS n FROM meals")).rows[0]).toMatchObject({ n: 1 });
});

it("does not let the beneficiary borrow another sender's draft scope, even in the same household", async () => {
 const created = await app.inject({ method: "POST", url: "/v1/meals/pending", headers: headers(senderA, "Cici"), payload: { ...meal, scopeKey: scope(senderA) } });
 for (const target of [undefined, "Cici", "Mahin"]) {
  const response = await app.inject({ method: "POST", url: `/v1/meals/pending/${created.json().id}/confirm`, headers: headers(senderB, target), payload: { scopeKey: scope(senderA) } });
  expect(response.statusCode).toBe(404);
 }
 expect((await pg.query("SELECT count(*)::int AS n FROM meals")).rows[0]).toMatchObject({ n: 0 });
});

it("rejects unknown, inactive, unauthorized-group and out-of-household recipients without writes", async () => {
 for (const target of ["Unknown", "00000000-0000-4000-8000-000000000003"]) expect((await app.inject({ method: "POST", url: "/v1/meals", headers: headers(senderA, target), payload: meal })).statusCode).toBe(403);
 await pg.query("UPDATE users SET active=false WHERE id=$1", [DEFAULT_PARTNER_USER_ID]);
 expect((await app.inject({ method: "POST", url: "/v1/meals", headers: headers(senderA, "Cici"), payload: meal })).statusCode).toBe(403);
 expect((await app.inject({ method: "POST", url: "/v1/meals", headers: { ...headers(senderA, "Cici"), "x-clawfit-conversation-id": "another-group@g.us" }, payload: meal })).statusCode).toBe(403);
 await pg.query("DELETE FROM household_members WHERE user_id=$1", [DEFAULT_PARTNER_USER_ID]);
 expect((await app.inject({ method: "POST", url: "/v1/meals", headers: headers(senderA, "Cici"), payload: meal })).statusCode).toBe(403);
 await pg.query("INSERT INTO household_members(household_id,user_id) SELECT household_id,$1 FROM household_members WHERE user_id=$2", [DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID]);
 expect((await pg.query("SELECT count(*)::int AS n FROM meals")).rows[0]).toMatchObject({ n: 0 });
});

it("routes named daily reads to the right owner and refuses recipient headers on workout/settings routes", async () => {
 await app.inject({ method: "POST", url: "/v1/meals", headers: headers(senderA, "Cici"), payload: meal });
 const response = await app.inject({ method: "GET", url: "/v1/nutrition/daily?date=2026-10-12", headers: headers(senderA, "Cici") });
 expect(response.json().totals.proteinG).toBe(30);
 const own = await app.inject({ method: "GET", url: "/v1/nutrition/daily?date=2026-10-12", headers: headers(senderA) });
 expect(own.json().meals).toHaveLength(0);
 for (const url of ["/v1/settings", "/v1/workouts/active"]) expect((await app.inject({ method: "GET", url, headers: headers(senderA, "Cici") })).statusCode).toBe(403);
});

it("lets an explicit household request confirm the partner's existing draft without impersonation or re-estimation", async () => {
 const created = await app.inject({ method: "POST", url: "/v1/meals/pending", headers: headers(senderB), payload: { ...meal, scopeKey: scope(senderB) } });
 expect(created.statusCode).toBe(201);
 const routeHeaders = headers(senderA, "Cici");
 const list = await app.inject({ method: "GET", url: `/v1/household/meals/pending/latest?scopeKey=${scope(senderA)}`, headers: routeHeaders });
 expect(list.json().pending.id).toBe(created.json().id);
 const operation = { method: "POST" as const, url: `/v1/household/meals/pending/${created.json().id}/confirm`, headers: routeHeaders, payload: { scopeKey: scope(senderA) } };
 const saved = await app.inject(operation);
 expect(saved.statusCode, saved.body).toBe(200);
 expect(saved.json()).toMatchObject({ userId: DEFAULT_PARTNER_USER_ID, caloriesBest: 400, proteinG: 30 });
 expect(JSON.parse(saved.json().rawUserText).householdConfirmation).toMatchObject({ confirmedByUserId: DEFAULT_PRIMARY_USER_ID, forUserId: DEFAULT_PARTNER_USER_ID });
 expect((await app.inject(operation)).json().id).toBe(saved.json().id);
 expect((await app.inject({ ...operation, headers: headers(senderA, "Mahin") })).statusCode).toBe(404);
 expect((await pg.query("SELECT count(*)::int AS n FROM meals")).rows[0]).toMatchObject({ n: 1 });
});
