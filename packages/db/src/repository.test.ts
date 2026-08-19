import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MealInput } from "@clawfit/health-core";
import type { HealthDatabase } from "./client.js";
import { HealthRepository } from "./repository.js";
import * as schema from "./schema.js";

const baseMeal: MealInput = {
  label: "Eggs and toast",
  items: [{ name: "eggs", portionDescription: "3 large" }],
  calories: { best: 500, low: 450, high: 575 },
  macros: { proteinG: 30, carbsG: 40, fatG: 24, fiberG: 5 },
  confidence: "medium",
  uncertaintyReasons: ["cooking fat"],
  occurredAt: new Date("2026-08-14T01:00:00.000Z"),
  source: "text",
  rawUserText: "3 eggs and toast",
  idempotencyKey: "meal-request-001",
};
const webScope = "web:primary";
const whatsappScope = "openclaw:whatsapp:peer-a";

describe("HealthRepository", () => {
  let pg: PGlite;
  let repository: HealthRepository;

  beforeEach(async () => {
    pg = new PGlite();
    const migrationsDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));
    const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
    for (const migrationName of migrations) {
      const migration = await readFile(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
      await pg.exec(migration.replaceAll("--> statement-breakpoint", ""));
    }
    const db = drizzle(pg, { schema }) as unknown as HealthDatabase;
    repository = new HealthRepository(db);
  });

  afterEach(async () => pg.close());

  it("creates, reads, updates, and deletes a meal", async () => {
    const created = await repository.createMeal(baseMeal);
    expect(created?.items).toHaveLength(1);
    const updated = await repository.updateMeal(created!.id, { caloriesBest: 525, caloriesLow: 475, caloriesHigh: 600 });
    expect(updated?.caloriesBest).toBe(525);
    await repository.deleteMeal(created!.id);
    await expect(repository.getMeal(created!.id)).rejects.toThrow("Meal not found");
  });

  it.each(["high", "medium", "low"] as const)("stores %s confidence", async (confidence) => {
    const created = await repository.createMeal({ ...baseMeal, confidence, idempotencyKey: `meal-${confidence}-01` });
    expect(created?.confidence).toBe(confidence);
  });

  it("is idempotent for meal creation", async () => {
    const first = await repository.createMeal(baseMeal);
    const second = await repository.createMeal({ ...baseMeal, label: "should not replace" });
    expect(second?.id).toBe(first?.id);
    expect(second?.label).toBe("Eggs and toast");
  });

  it("rejects an invalid correction without persisting it", async () => {
    const created = await repository.createMeal(baseMeal);
    await expect(repository.updateMeal(created!.id, { caloriesBest: 300 })).rejects.toThrow("low <= best <= high");
    expect((await repository.getMeal(created!.id)).caloriesBest).toBe(500);
  });

  it("calculates daily totals", async () => {
    await repository.createMeal(baseMeal);
    await repository.createMeal({ ...baseMeal, calories: { best: 300, low: 250, high: 350 }, idempotencyKey: "meal-request-002" });
    const daily = await repository.dailyNutrition(new Date("2026-08-14T00:00:00Z"), new Date("2026-08-15T00:00:00Z"));
    expect(daily.totals.caloriesBest).toBe(800);
    expect(daily.totals.caloriesLow).toBe(700);
  });

  it("creates a workout with multiple sets and deterministic volume", async () => {
    const result = await repository.startWorkout({ name: "Push", startedAt: new Date("2026-08-14T09:00:00Z"), idempotencyKey: "workout-start-001" });
    await repository.addWorkoutSet(result.workout.id, { exerciseName: "Bench press", weightKg: 80, reps: 8, idempotencyKey: "bench-set-001" });
    await repository.addWorkoutSet(result.workout.id, { exerciseName: "Bench press", weightKg: 80, reps: 7, idempotencyKey: "bench-set-002" });
    const workout = await repository.getWorkout(result.workout.id);
    expect(workout.setCount).toBe(2);
    expect(workout.volumeKg).toBe(1_200);
    expect(workout.exercises[0]?.sets[0]?.estimatedOneRepMax).toBe(101.3);
  });

  it("corrects and deletes an existing workout set", async () => {
    const result = await repository.startWorkout({ name: "Push", idempotencyKey: "workout-start-002" });
    const set = await repository.addWorkoutSet(result.workout.id, { exerciseName: "Bench", weightKg: 80, reps: 8, idempotencyKey: "bench-set-003" });
    const corrected = await repository.updateWorkoutSet(set.id, { weightKg: 82.5, reps: 7 });
    expect(corrected.weightKg).toBe(82.5);
    expect(corrected.reps).toBe(7);
    await repository.deleteWorkoutSet(set.id);
    expect((await repository.getWorkout(result.workout.id)).setCount).toBe(0);
  });

  it("creates, retrieves, and confirms a pending meal estimate idempotently", async () => {
    const pending = await repository.createPendingMeal({
      ...baseMeal,
      scopeKey: webScope,
      idempotencyKey: "pending-meal-001",
      expiresInSeconds: 3600,
    });
    expect(pending.id).toBeDefined();
    expect(pending.confirmed).toBe(false);

    const latest = await repository.getLatestPendingMeal(webScope);
    expect(latest?.id).toBe(pending.id);

    const confirmed = await repository.confirmPendingMeal(pending.id, { scopeKey: webScope, idempotencyKey: "client-confirm-attempt-001" });
    expect(confirmed?.label).toBe("Eggs and toast");
    expect(confirmed?.items).toHaveLength(1);

    const pendingAfter = await repository.getPendingMeal(pending.id, webScope);
    expect(pendingAfter.confirmed).toBe(true);
    expect(pendingAfter.mealId).toBe(confirmed?.id);

    // Confirming again returns the exact same meal without duplicate records
    const confirmedAgain = await repository.confirmPendingMeal(pending.id, { scopeKey: webScope, idempotencyKey: "client-confirm-attempt-002" });
    expect(confirmedAgain?.id).toBe(confirmed?.id);

    // Latest pending meal no longer returns confirmed meal
    const latestAfter = await repository.getLatestPendingMeal(webScope);
    expect(latestAfter).toBeNull();
  });

  it("edits and cancels pending meal drafts without creating meals", async () => {
    const pending = await repository.createPendingMeal({ ...baseMeal, scopeKey: webScope, idempotencyKey: "pending-meal-edit-001", expiresInSeconds: 3600 });
    const edited = await repository.updatePendingMeal(pending.id, webScope, { label: "Two eggs and toast", caloriesBest: 420, caloriesLow: 380 });
    expect(edited.label).toBe("Two eggs and toast");
    expect(edited.caloriesBest).toBe(420);
    const cancelled = await repository.cancelPendingMeal(pending.id, webScope);
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(await repository.getLatestPendingMeal(webScope)).toBeNull();
    await expect(repository.confirmPendingMeal(pending.id, { scopeKey: webScope })).rejects.toThrow("cancelled");
  });

  it("isolates pending meals across web and WhatsApp scopes", async () => {
    const webPending = await repository.createPendingMeal({ ...baseMeal, scopeKey: webScope, idempotencyKey: "shared-request-key", expiresInSeconds: 3600 });
    const whatsappPending = await repository.createPendingMeal({ ...baseMeal, scopeKey: whatsappScope, label: "WhatsApp draft", idempotencyKey: "shared-request-key", expiresInSeconds: 3600 });

    expect((await repository.getLatestPendingMeal(webScope))?.id).toBe(webPending.id);
    expect((await repository.getLatestPendingMeal(whatsappScope))?.id).toBe(whatsappPending.id);
    await expect(repository.getPendingMeal(whatsappPending.id, webScope)).rejects.toThrow("not found");
    await expect(repository.confirmPendingMeal(whatsappPending.id, { scopeKey: webScope })).rejects.toThrow("not found");

    const confirmed = await repository.confirmPendingMeal(whatsappPending.id, { scopeKey: whatsappScope });
    const confirmedAgain = await repository.confirmPendingMeal(whatsappPending.id, { scopeKey: whatsappScope });
    expect(confirmedAgain?.id).toBe(confirmed?.id);
    expect((await repository.getLatestPendingMeal(webScope))?.id).toBe(webPending.id);
  });

  it("does not confirm an unconfirmed draft after its two-hour TTL", async () => {
    const pending = await repository.createPendingMeal({ ...baseMeal, scopeKey: webScope, idempotencyKey: "pending-meal-expiry-001", expiresInSeconds: 7_200 });
    const afterExpiry = new Date(pending.expiresAt.getTime() + 1);

    expect(await repository.getLatestPendingMeal(webScope, afterExpiry)).toBeNull();
    await expect(repository.confirmPendingMeal(pending.id, { scopeKey: webScope }, afterExpiry)).rejects.toThrow("expired");
  });

  it("persists personal goals and notification preferences", async () => {
    expect((await repository.getSettings()).calorieTarget).toBe(2200);
    const settings = await repository.updateSettings({ calorieTarget: 2450, proteinTargetG: 175, timezone: "Asia/Kuala_Lumpur", preferredUnits: "metric" });
    expect(settings.calorieTarget).toBe(2450);
    const preference = await repository.upsertNotificationPreference({
      type: "evening_progress",
      enabled: true,
      timeLocal: "20:30",
      timezone: "Asia/Kuala_Lumpur",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      deliveryChannel: "web_push",
      configuration: {},
    });
    expect(preference.enabled).toBe(true);
    expect(await repository.listNotificationPreferences()).toHaveLength(1);
  });
});
