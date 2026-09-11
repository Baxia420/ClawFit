import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MealInput } from "@clawfit/health-core";
import type { HealthDatabase } from "./client.js";
import { DEFAULT_HOUSEHOLD_ID, DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID, HealthRepository } from "./repository.js";
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
  const primaryUserId = DEFAULT_PRIMARY_USER_ID;

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
    const created = await repository.createMeal(primaryUserId, baseMeal);
    expect(created?.items).toHaveLength(1);
    const updated = await repository.updateMeal(primaryUserId, created!.id, { caloriesBest: 525, caloriesLow: 475, caloriesHigh: 600 });
    expect(updated?.caloriesBest).toBe(525);
    await repository.deleteMeal(primaryUserId, created!.id);
    await expect(repository.getMeal(primaryUserId, created!.id)).rejects.toThrow("Meal not found");
  });

  it.each(["high", "medium", "low"] as const)("stores %s confidence", async (confidence) => {
    const created = await repository.createMeal(primaryUserId, { ...baseMeal, confidence, idempotencyKey: `meal-${confidence}-01` });
    expect(created?.confidence).toBe(confidence);
  });

  it("is idempotent for meal creation", async () => {
    const first = await repository.createMeal(primaryUserId, baseMeal);
    const second = await repository.createMeal(primaryUserId, { ...baseMeal, label: "should not replace" });
    expect(second?.id).toBe(first?.id);
    expect(second?.label).toBe("Eggs and toast");
  });

  it("rejects an invalid correction without persisting it", async () => {
    const created = await repository.createMeal(primaryUserId, baseMeal);
    await expect(repository.updateMeal(primaryUserId, created!.id, { caloriesBest: 300 })).rejects.toThrow("low <= best <= high");
    expect((await repository.getMeal(primaryUserId, created!.id)).caloriesBest).toBe(500);
  });

  it("calculates daily totals", async () => {
    await repository.createMeal(primaryUserId, baseMeal);
    await repository.createMeal(primaryUserId, { ...baseMeal, calories: { best: 300, low: 250, high: 350 }, idempotencyKey: "meal-request-002" });
    const daily = await repository.dailyNutrition(primaryUserId, new Date("2026-08-14T00:00:00Z"), new Date("2026-08-15T00:00:00Z"));
    expect(daily.totals.caloriesBest).toBe(800);
    expect(daily.totals.caloriesLow).toBe(700);
  });

  it("aggregates nutrition trends through typed timestamp boundaries", async () => {
    await repository.createMeal(primaryUserId, baseMeal);
    await repository.createMeal(primaryUserId, { ...baseMeal, calories: { best: 300, low: 250, high: 350 }, idempotencyKey: "meal-trend-002" });

    const trend = await repository.nutritionTrend(primaryUserId, new Date("2026-08-14T00:00:00Z"), new Date("2026-08-15T00:00:00Z"));

    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ calories_best: 800, calories_low: 700, calories_high: 925, protein_g: 60 });
  });

  it("aligns nutrition trends and daily queries with user local calendar days across UTC boundaries", async () => {
    await pg.query("SET TIME ZONE 'UTC'");
    const userA = primaryUserId;
    const userB = DEFAULT_PARTNER_USER_ID;
    const timezone = "Asia/Kuala_Lumpur";

    // 2026-09-10T15:30:00Z is September 10 at 23:30 in Asia/Kuala_Lumpur (+08:00)
    const mealSep10 = await repository.createMeal(userA, {
      ...baseMeal,
      label: "Late Dinner Sep 10",
      calories: { best: 300, low: 270, high: 330 },
      occurredAt: new Date("2026-09-10T15:30:00Z"),
      idempotencyKey: "meal-sep10-late",
    });

    // 2026-09-10T16:30:00Z is September 11 at 00:30 in Asia/Kuala_Lumpur (+08:00)
    const mealSep11 = await repository.createMeal(userA, {
      ...baseMeal,
      label: "Midnight Snack Sep 11",
      calories: { best: 300, low: 270, high: 330 },
      occurredAt: new Date("2026-09-10T16:30:00Z"),
      idempotencyKey: "meal-sep11-early",
    });

    // Define 7-day window ending on 2026-09-11 in Asia/Kuala_Lumpur
    // Start of 7D window: 2026-09-05 00:00:00 KL = 2026-09-04T16:00:00Z
    // End of 7D window: 2026-09-12 00:00:00 KL = 2026-09-11T16:00:00Z
    const windowStart = new Date("2026-09-04T16:00:00Z");
    const windowEnd = new Date("2026-09-11T16:00:00Z");

    // Boundary meal: right at window start boundary (inclusive in gte)
    await repository.createMeal(userA, {
      ...baseMeal,
      label: "Window Start Boundary Meal",
      calories: { best: 200, low: 180, high: 220 },
      occurredAt: new Date("2026-09-04T16:00:00Z"),
      idempotencyKey: "meal-window-start",
    });

    // Boundary meal: 1 second before window start (excluded)
    await repository.createMeal(userA, {
      ...baseMeal,
      label: "Before Window Meal",
      calories: { best: 999, low: 900, high: 1100 },
      occurredAt: new Date("2026-09-04T15:59:59Z"),
      idempotencyKey: "meal-before-window",
    });

    // Boundary meal: right at window end boundary (excluded by lt)
    await repository.createMeal(userA, {
      ...baseMeal,
      label: "At Window End Meal",
      calories: { best: 888, low: 800, high: 950 },
      occurredAt: new Date("2026-09-11T16:00:00Z"),
      idempotencyKey: "meal-window-end",
    });

    // User B meals at identical timestamps to verify strict user isolation
    await repository.createMeal(userB, {
      ...baseMeal,
      label: "Partner Meal Sep 10",
      calories: { best: 500, low: 450, high: 550 },
      occurredAt: new Date("2026-09-10T15:30:00Z"),
      idempotencyKey: "meal-partner-sep10",
    });
    await repository.createMeal(userB, {
      ...baseMeal,
      label: "Partner Meal Sep 11",
      calories: { best: 500, low: 450, high: 550 },
      occurredAt: new Date("2026-09-10T16:30:00Z"),
      idempotencyKey: "meal-partner-sep11",
    });

    // 1. Verify dailyNutrition for Sep 10 and Sep 11 produces separate local-day totals of 300 kcal
    const dailySep10 = await repository.dailyNutrition(userA, new Date("2026-09-09T16:00:00Z"), new Date("2026-09-10T16:00:00Z"));
    expect(dailySep10.totals.caloriesBest).toBe(300);
    expect(dailySep10.meals).toHaveLength(1);
    expect(dailySep10.meals[0]!.id).toBe(mealSep10!.id);

    const dailySep11 = await repository.dailyNutrition(userA, new Date("2026-09-10T16:00:00Z"), new Date("2026-09-11T16:00:00Z"));
    expect(dailySep11.totals.caloriesBest).toBe(300);
    expect(dailySep11.meals).toHaveLength(1);
    expect(dailySep11.meals[0]!.id).toBe(mealSep11!.id);

    // 2. Verify nutritionTrend returns separate local calendar days: 2026-09-10 and 2026-09-11
    const trendA = await repository.nutritionTrend(userA, windowStart, windowEnd, timezone);

    expect(trendA).toHaveLength(3);
    expect(trendA).toEqual([
      { day: "2026-09-05", calories_best: 200, calories_low: 180, calories_high: 220, protein_g: 30 },
      { day: "2026-09-10", calories_best: 300, calories_low: 270, calories_high: 330, protein_g: 30 },
      { day: "2026-09-11", calories_best: 300, calories_low: 270, calories_high: 330, protein_g: 30 },
    ]);

    // 3. Verify user isolation holds in trend
    const trendB = await repository.nutritionTrend(userB, windowStart, windowEnd, timezone);
    expect(trendB).toHaveLength(2);
    expect(trendB).toEqual([
      { day: "2026-09-10", calories_best: 500, calories_low: 450, calories_high: 550, protein_g: 30 },
      { day: "2026-09-11", calories_best: 500, calories_low: 450, calories_high: 550, protein_g: 30 },
    ]);
  });

  it("creates a workout with multiple sets and deterministic volume", async () => {
    const result = await repository.startWorkout(primaryUserId, { name: "Push", startedAt: new Date("2026-08-14T09:00:00Z"), idempotencyKey: "workout-start-001" });
    await repository.addWorkoutSet(primaryUserId, result.workout.id, { exerciseName: "Bench press", weightKg: 80, reps: 8, idempotencyKey: "bench-set-001" });
    await repository.addWorkoutSet(primaryUserId, result.workout.id, { exerciseName: "Bench press", weightKg: 80, reps: 7, idempotencyKey: "bench-set-002" });
    const workout = await repository.getWorkout(primaryUserId, result.workout.id);
    expect(workout.setCount).toBe(2);
    expect(workout.volumeKg).toBe(1_200);
    expect(workout.exercises[0]?.sets[0]?.estimatedOneRepMax).toBe(101.3);
  });

  it("reuses workout and set records when create requests are retried", async () => {
    const firstWorkout = await repository.startWorkout(primaryUserId, { name: "Pull", idempotencyKey: "workout-retry-001" });
    const retriedWorkout = await repository.startWorkout(primaryUserId, { name: "Should not replace", idempotencyKey: "workout-retry-001" });
    expect(retriedWorkout.workout.id).toBe(firstWorkout.workout.id);
    expect(retriedWorkout.workout.name).toBe("Pull");

    const firstSet = await repository.addWorkoutSet(primaryUserId, firstWorkout.workout.id, { exerciseName: "Row", weightKg: 40, reps: 10, idempotencyKey: "set-retry-001" });
    const retriedSet = await repository.addWorkoutSet(primaryUserId, firstWorkout.workout.id, { exerciseName: "Should not replace", weightKg: 400, reps: 1, idempotencyKey: "set-retry-001" });
    expect(retriedSet.id).toBe(firstSet.id);
    expect(retriedSet.weightKg).toBe(40);
    expect((await repository.getActiveWorkout(primaryUserId))?.setCount).toBe(1);

    await repository.finishWorkout(primaryUserId, firstWorkout.workout.id);
    expect(await repository.getActiveWorkout(primaryUserId)).toBeNull();
  });

  it("corrects and deletes an existing workout set", async () => {
    const result = await repository.startWorkout(primaryUserId, { name: "Push", idempotencyKey: "workout-start-002" });
    const set = await repository.addWorkoutSet(primaryUserId, result.workout.id, { exerciseName: "Bench", weightKg: 80, reps: 8, idempotencyKey: "bench-set-003" });
    const corrected = await repository.updateWorkoutSet(primaryUserId, set.id, { weightKg: 82.5, reps: 7 });
    expect(corrected.weightKg).toBe(82.5);
    expect(corrected.reps).toBe(7);
    await repository.deleteWorkoutSet(primaryUserId, set.id);
    expect((await repository.getWorkout(primaryUserId, result.workout.id)).setCount).toBe(0);
  });

  it("creates, retrieves, and confirms a pending meal estimate idempotently", async () => {
    const pending = await repository.createPendingMeal(primaryUserId, {
      ...baseMeal,
      scopeKey: webScope,
      idempotencyKey: "pending-meal-001",
      expiresInSeconds: 3600,
    });
    expect(pending.id).toBeDefined();
    expect(pending.confirmed).toBe(false);

    const latest = await repository.getLatestPendingMeal(primaryUserId, webScope);
    expect(latest?.id).toBe(pending.id);

    const confirmed = await repository.confirmPendingMeal(primaryUserId, pending.id, { scopeKey: webScope, idempotencyKey: "client-confirm-attempt-001" });
    expect(confirmed?.label).toBe("Eggs and toast");
    expect(confirmed?.items).toHaveLength(1);

    const pendingAfter = await repository.getPendingMeal(primaryUserId, pending.id, webScope);
    expect(pendingAfter.confirmed).toBe(true);
    expect(pendingAfter.mealId).toBe(confirmed?.id);

    // Confirming again returns the exact same meal without duplicate records
    const confirmedAgain = await repository.confirmPendingMeal(primaryUserId, pending.id, { scopeKey: webScope, idempotencyKey: "client-confirm-attempt-002" });
    expect(confirmedAgain?.id).toBe(confirmed?.id);

    // Latest pending meal no longer returns confirmed meal
    const latestAfter = await repository.getLatestPendingMeal(primaryUserId, webScope);
    expect(latestAfter).toBeNull();
  });

  it("edits and cancels pending meal drafts without creating meals", async () => {
    const pending = await repository.createPendingMeal(primaryUserId, { ...baseMeal, scopeKey: webScope, idempotencyKey: "pending-meal-edit-001", expiresInSeconds: 3600 });
    const edited = await repository.updatePendingMeal(primaryUserId, pending.id, webScope, { label: "Two eggs and toast", caloriesBest: 420, caloriesLow: 380 });
    expect(edited.label).toBe("Two eggs and toast");
    expect(edited.caloriesBest).toBe(420);
    const cancelled = await repository.cancelPendingMeal(primaryUserId, pending.id, webScope);
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(await repository.getLatestPendingMeal(primaryUserId, webScope)).toBeNull();
    await expect(repository.confirmPendingMeal(primaryUserId, pending.id, { scopeKey: webScope })).rejects.toThrow("cancelled");
  });

  it("isolates pending meals across web and WhatsApp scopes", async () => {
    const webPending = await repository.createPendingMeal(primaryUserId, { ...baseMeal, scopeKey: webScope, idempotencyKey: "shared-request-key", expiresInSeconds: 3600 });
    const whatsappPending = await repository.createPendingMeal(primaryUserId, { ...baseMeal, scopeKey: whatsappScope, label: "WhatsApp draft", idempotencyKey: "shared-request-key", expiresInSeconds: 3600 });

    expect((await repository.getLatestPendingMeal(primaryUserId, webScope))?.id).toBe(webPending.id);
    expect((await repository.getLatestPendingMeal(primaryUserId, whatsappScope))?.id).toBe(whatsappPending.id);
    await expect(repository.getPendingMeal(primaryUserId, whatsappPending.id, webScope)).rejects.toThrow("not found");
    await expect(repository.confirmPendingMeal(primaryUserId, whatsappPending.id, { scopeKey: webScope })).rejects.toThrow("not found");

    const confirmed = await repository.confirmPendingMeal(primaryUserId, whatsappPending.id, { scopeKey: whatsappScope });
    const confirmedAgain = await repository.confirmPendingMeal(primaryUserId, whatsappPending.id, { scopeKey: whatsappScope });
    expect(confirmedAgain?.id).toBe(confirmed?.id);
    expect((await repository.getLatestPendingMeal(primaryUserId, webScope))?.id).toBe(webPending.id);
  });

  it("does not confirm an unconfirmed draft after its two-hour TTL", async () => {
    const pending = await repository.createPendingMeal(primaryUserId, { ...baseMeal, scopeKey: webScope, idempotencyKey: "pending-meal-expiry-001", expiresInSeconds: 7_200 });
    const afterExpiry = new Date(pending.expiresAt.getTime() + 1);

    expect(await repository.getLatestPendingMeal(primaryUserId, webScope, afterExpiry)).toBeNull();
    await expect(repository.confirmPendingMeal(primaryUserId, pending.id, { scopeKey: webScope }, afterExpiry)).rejects.toThrow("expired");
  });

  it("lists multiple pending meal drafts in order and respects scope", async () => {
    const p1 = await repository.createPendingMeal(primaryUserId, {
      ...baseMeal,
      label: "Meal 1",
      scopeKey: whatsappScope,
      idempotencyKey: "multi-pending-001",
      expiresInSeconds: 3600,
    });
    const p2 = await repository.createPendingMeal(primaryUserId, {
      ...baseMeal,
      label: "Meal 2",
      scopeKey: whatsappScope,
      idempotencyKey: "multi-pending-002",
      expiresInSeconds: 3600,
    });
    // Create one in web scope
    await repository.createPendingMeal(primaryUserId, {
      ...baseMeal,
      label: "Web Meal",
      scopeKey: webScope,
      idempotencyKey: "multi-pending-web",
      expiresInSeconds: 3600,
    });

    const pendingList = await repository.listPendingMeals(primaryUserId, whatsappScope);
    expect(pendingList).toHaveLength(2);
    expect(pendingList.map((p) => p.id)).toEqual([p2.id, p1.id]);

    // Confirm p1 and verify list only returns p2
    await repository.confirmPendingMeal(primaryUserId, p1.id, { scopeKey: whatsappScope });
    const pendingListAfter = await repository.listPendingMeals(primaryUserId, whatsappScope);
    expect(pendingListAfter).toHaveLength(1);
    expect(pendingListAfter[0]?.id).toBe(p2.id);
  });

  it("handles updateMeal using a pending meal ID appropriately", async () => {
    const pending = await repository.createPendingMeal(primaryUserId, {
      ...baseMeal,
      scopeKey: whatsappScope,
      idempotencyKey: "pending-redirect-001",
      expiresInSeconds: 3600,
    });

    // Attempting to update meal using unconfirmed pending ID throws ConflictError
    await expect(repository.updateMeal(primaryUserId, pending.id, { label: "Updated Label" })).rejects.toThrow(
      "Cannot update meal with pending draft ID",
    );

    // Confirm the pending meal
    const confirmed = await repository.confirmPendingMeal(primaryUserId, pending.id, { scopeKey: whatsappScope });
    expect(confirmed).toBeDefined();

    // Now updating meal using the pending ID forwards and updates the confirmed meal
    const updated = await repository.updateMeal(primaryUserId, pending.id, { label: "Corrected After Confirmation" });
    expect(updated.id).toBe(confirmed!.id);
    expect(updated.label).toBe("Corrected After Confirmation");
  });

  it("verifies fresh daily totals: existing 1490 + draft A 250 + draft B 45 = 1785, post-write read, partial failure retry, user isolation, and date corrections", async () => {
    const userA = primaryUserId;
    const userB = DEFAULT_PARTNER_USER_ID;
    const todayStart = new Date("2026-09-07T16:00:00.000Z"); // 2026-09-08 00:00 KL (+08:00)
    const todayEnd = new Date("2026-09-08T16:00:00.000Z");   // 2026-09-09 00:00 KL (+08:00)
    const yesterdayStart = new Date("2026-09-06T16:00:00.000Z"); // 2026-09-07 00:00 KL (+08:00)
    const yesterdayEnd = todayStart;

    // 1. Setup existing meal of 1490 calories for userA today
    await repository.createMeal(userA, {
      ...baseMeal,
      label: "Lunch & Afternoon snacks",
      calories: { best: 1490, low: 1400, high: 1580 },
      occurredAt: new Date("2026-09-08T04:00:00.000Z"), // 12:00 PM KL
      idempotencyKey: "meal-existing-1490",
    });

    // 2. Setup existing meal of 600 calories for partner (userB) today (non-zero partner baseline)
    await repository.createMeal(userB, {
      ...baseMeal,
      label: "Partner healthy brunch bowl",
      calories: { best: 600, low: 550, high: 650 },
      occurredAt: new Date("2026-09-08T03:30:00.000Z"), // 11:30 AM KL
      idempotencyKey: "meal-partner-existing-600",
    });

    // Verify baseline totals before confirmation
    const baselineA = await repository.dailyNutrition(userA, todayStart, todayEnd);
    expect(baselineA.totals.caloriesBest).toBe(1490);
    const baselineB = await repository.dailyNutrition(userB, todayStart, todayEnd);
    expect(baselineB.totals.caloriesBest).toBe(600);

    // 3. User A creates draft A (250 kcal) and draft B (45 kcal)
    const draftA = await repository.createPendingMeal(userA, {
      ...baseMeal,
      label: "Draft A: Greek yogurt",
      calories: { best: 250, low: 230, high: 270 },
      occurredAt: new Date("2026-09-08T08:00:00.000Z"), // 4:00 PM KL
      scopeKey: whatsappScope,
      idempotencyKey: "draft-a-250",
      expiresInSeconds: 7200,
    });
    const draftB = await repository.createPendingMeal(userA, {
      ...baseMeal,
      label: "Draft B: Espresso with splash of milk",
      calories: { best: 45, low: 40, high: 50 },
      occurredAt: new Date("2026-09-08T09:00:00.000Z"), // 5:00 PM KL
      scopeKey: whatsappScope,
      idempotencyKey: "draft-b-45",
      expiresInSeconds: 7200,
    });

    // Prior to confirmation, daily total remains strictly 1490
    expect((await repository.dailyNutrition(userA, todayStart, todayEnd)).totals.caloriesBest).toBe(1490);

    // 4. Test compound confirmation with write-before-read ordering assertion:
    // 1490 + 250 + 45 = 1785
    const executionOrder: string[] = [];
    const origConfirm = repository.confirmPendingMeal.bind(repository);
    const origDaily = repository.dailyNutrition.bind(repository);

    vi.spyOn(repository, "confirmPendingMeal").mockImplementation(async (...args) => {
      executionOrder.push(`write:${args[1]}`);
      return origConfirm(...args);
    });
    vi.spyOn(repository, "dailyNutrition").mockImplementation(async (...args) => {
      executionOrder.push(`read:${args[0]}`);
      return origDaily(...args);
    });

    const compoundResult = await repository.confirmPendingMealsWithSummary(
      userA,
      [
        { id: draftA.id, scopeKey: whatsappScope },
        { id: draftB.id, scopeKey: whatsappScope },
      ],
      { date: "2026-09-08", timezone: "Asia/Kuala_Lumpur" },
    );

    // Verify write-before-read ordering: both writes finished before reading daily nutrition
    expect(executionOrder).toEqual([`write:${draftA.id}`, `write:${draftB.id}`, `read:${userA}`]);
    expect(compoundResult.status).toBe("confirmed");
    expect(compoundResult.confirmedMeals).toHaveLength(2);
    expect(compoundResult.dailyNutrition).toBeDefined();
    expect(compoundResult.dailyNutrition!.totals.caloriesBest).toBe(1785);

    // 5. Test partial failure handling via compound operation:
    const draftC = await repository.createPendingMeal(userA, {
      ...baseMeal,
      label: "Draft C: Apple",
      calories: { best: 95, low: 85, high: 105 },
      occurredAt: new Date("2026-09-08T10:00:00.000Z"),
      scopeKey: whatsappScope,
      idempotencyKey: "draft-c-95",
      expiresInSeconds: 7200,
    });
    const draftD = await repository.createPendingMeal(userA, {
      ...baseMeal,
      label: "Draft D: Walnuts",
      calories: { best: 150, low: 140, high: 160 },
      occurredAt: new Date("2026-09-08T10:30:00.000Z"),
      scopeKey: whatsappScope,
      idempotencyKey: "draft-d-150",
      expiresInSeconds: 7200,
    });

    const partialResult = await repository.confirmPendingMealsWithSummary(
      userA,
      [
        { id: draftC.id, scopeKey: whatsappScope },
        { id: draftD.id, scopeKey: "wrong-scope" }, // will fail
      ],
      { date: "2026-09-08", timezone: "Asia/Kuala_Lumpur" },
    );

    expect(partialResult.status).toBe("partial_success");
    expect(partialResult.partialSuccess).toBe(true);
    expect(partialResult.confirmedMeals).toHaveLength(1);
    expect(partialResult.confirmedMeals[0]!.idempotencyKey).toBe(`confirmed_${draftC.id}`);
    expect(partialResult.failures).toHaveLength(1);
    expect(partialResult.failures[0]!.pendingDraftId).toBe(draftD.id);
    // Fresh daily total reflects 1785 + 95 = 1880
    expect(partialResult.dailyNutrition!.totals.caloriesBest).toBe(1880);

    // Safe retry of draft D with correct scope succeeds
    const retryResult = await repository.confirmPendingMealsWithSummary(
      userA,
      [{ id: draftD.id, scopeKey: whatsappScope }],
      { date: "2026-09-08", timezone: "Asia/Kuala_Lumpur" },
    );
    expect(retryResult.status).toBe("confirmed");
    // Daily total now reflects 1880 + 150 = 2030
    expect(retryResult.dailyNutrition!.totals.caloriesBest).toBe(2030);

    // 6. Test summary read failure isolation:
    // If dailyNutrition throws after successful write, mutation is preserved and summaryError is set
    const draftE = await repository.createPendingMeal(userA, {
      ...baseMeal,
      label: "Draft E: Mint tea",
      calories: { best: 5, low: 0, high: 10 },
      occurredAt: new Date("2026-09-08T11:00:00.000Z"),
      scopeKey: whatsappScope,
      idempotencyKey: "draft-e-5",
      expiresInSeconds: 7200,
    });

    vi.spyOn(repository, "dailyNutrition").mockRejectedValueOnce(new Error("Database summary timeout"));
    const summaryFailResult = await repository.confirmPendingMealsWithSummary(
      userA,
      [{ id: draftE.id, scopeKey: whatsappScope }],
      { date: "2026-09-08", timezone: "Asia/Kuala_Lumpur" },
    );

    // Mutation succeeded and confirmed ID is preserved
    expect(summaryFailResult.status).toBe("confirmed");
    expect(summaryFailResult.confirmedMeals).toHaveLength(1);
    expect(summaryFailResult.failures).toHaveLength(0);
    expect(summaryFailResult.summaryError).toContain("Database summary timeout");
    expect(summaryFailResult.dailyNutrition).toBeUndefined();

    // The confirmed meal is indeed committed to the database
    const confirmedE = await repository.getMeal(userA, summaryFailResult.confirmedMeals[0]!.id);
    expect(confirmedE.label).toBe("Draft E: Mint tea");

    // Retrying does not duplicate the record
    const idempotentRetry = await repository.confirmPendingMealsWithSummary(
      userA,
      [{ id: draftE.id, scopeKey: whatsappScope }],
      { date: "2026-09-08", timezone: "Asia/Kuala_Lumpur" },
    );
    expect(idempotentRetry.status).toBe("confirmed");
    expect(idempotentRetry.confirmedMeals[0]!.id).toBe(confirmedE.id);

    // 7. Date corrections: user corrects draft B to yesterday (2026-09-07) using updateMealWithSummary
    const confirmedBId = compoundResult.confirmedMeals.find((m) => m.label.includes("Draft B"))!.id;
    const dateCorrectionResult = await repository.updateMealWithSummary(
      userA,
      confirmedBId,
      { occurredAt: new Date("2026-09-07T12:00:00.000Z") },
      { date: "2026-09-08", timezone: "Asia/Kuala_Lumpur" },
    );

    expect(dateCorrectionResult.meal.id).toBe(confirmedBId);
    // Today's total is reduced by draft B (45 kcal): 2035 - 45 = 1990
    expect(dateCorrectionResult.dailyNutrition!.totals.caloriesBest).toBe(1990);

    // Yesterday's total now includes draft B (45 kcal)
    const yesterdaySummary = await repository.dailyNutrition(userA, yesterdayStart, yesterdayEnd);
    expect(yesterdaySummary.totals.caloriesBest).toBe(45);

    // 8. Strict two-user isolation with non-zero partner baseline:
    // Partner (userB) receives her own existing total of 600 kcal (NOT 0, NOT affected by userA's 1990)
    const partnerToday = await repository.dailyNutrition(userB, todayStart, todayEnd);
    expect(partnerToday.totals.caloriesBest).toBe(600);
    expect(partnerToday.meals).toHaveLength(1);
    expect(partnerToday.meals[0]!.label).toBe("Partner healthy brunch bowl");

    // User A's daily total remains 1990 and contains zero meals from partner
    const userAFinal = await repository.dailyNutrition(userA, todayStart, todayEnd);
    expect(userAFinal.totals.caloriesBest).toBe(1990);
    expect(userAFinal.meals.every((m) => m.userId === userA)).toBe(true);

    vi.restoreAllMocks();
  });

  it("persists personal goals and notification preferences", async () => {
    expect((await repository.getSettings(primaryUserId)).calorieTarget).toBe(2200);
    const settings = await repository.updateSettings(primaryUserId, { calorieTarget: 2450, proteinTargetG: 175, timezone: "Asia/Kuala_Lumpur", preferredUnits: "metric" });
    expect(settings.calorieTarget).toBe(2450);
    const preference = await repository.upsertNotificationPreference(primaryUserId, {
      type: "evening_progress",
      enabled: true,
      timeLocal: "20:30",
      timezone: "Asia/Kuala_Lumpur",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      deliveryChannel: "web_push",
      configuration: {},
    });
    expect(preference.enabled).toBe(true);
    expect(await repository.listNotificationPreferences(primaryUserId)).toHaveLength(1);
  });

  describe("two-user identity foundation and data isolation", () => {
    const userA = DEFAULT_PRIMARY_USER_ID;
    const userB = DEFAULT_PARTNER_USER_ID;

    it("verifies bootstrapped primary user, partner user, and household relationship", async () => {
      const users = await repository.listUsers();
      expect(users).toHaveLength(2);
      expect(users.map((u) => ({ id: u.id, role: u.role }))).toEqual([
        { id: userA, role: "primary" },
        { id: userB, role: "partner" },
      ]);

      const members = await repository.getHouseholdMembers(DEFAULT_HOUSEHOLD_ID);
      expect(members).toHaveLength(2);

      const partnerOfA = await repository.getPartnerUser(userA);
      expect(partnerOfA?.id).toBe(userB);

      const partnerOfB = await repository.getPartnerUser(userB);
      expect(partnerOfB?.id).toBe(userA);
    });

    it("supports multiple external identity aliases for the same ClawFit user (E.164 and LID)", async () => {
      await repository.linkExternalIdentity({
        userId: userA,
        provider: "whatsapp",
        externalIdentifier: "+60123456789",
      });
      await repository.linkExternalIdentity({
        userId: userA,
        provider: "whatsapp",
        externalIdentifier: "12345678901234@lid",
      });

      const fromPhone = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "+60123456789" });
      expect(fromPhone.resolved).toBe(true);
      if (fromPhone.resolved) {
        expect(fromPhone.user.id).toBe(userA);
      }

      // Normalization: resolving using JID format or raw digits resolves to normalized phone
      const fromJid = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "60123456789@s.whatsapp.net" });
      expect(fromJid.resolved).toBe(true);
      if (fromJid.resolved) {
        expect(fromJid.user.id).toBe(userA);
      }

      const fromRawDigits = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "60123456789" });
      expect(fromRawDigits.resolved).toBe(true);
      if (fromRawDigits.resolved) {
        expect(fromRawDigits.user.id).toBe(userA);
      }

      const fromLid = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "12345678901234@lid" });
      expect(fromLid.resolved).toBe(true);
      if (fromLid.resolved) {
        expect(fromLid.user.id).toBe(userA);
      }
    });

    it("rejects resolution of inactive users", async () => {
      // Create an inactive user
      const inactiveUser = await repository.createUser({
        role: "partner",
        displayName: "Inactive Partner",
        active: false,
      });

      await repository.linkExternalIdentity({
        userId: inactiveUser.id,
        provider: "whatsapp",
        externalIdentifier: "+60177778888",
      });

      const result = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "+60177778888" });
      expect(result.resolved).toBe(false);
      if (!result.resolved) {
        expect(result.reason).toBe("user_inactive_or_missing");
      }
    });

    it("links and resolves external identities with duplicate prevention", async () => {
      await repository.linkExternalIdentity({
        userId: userA,
        provider: "whatsapp",
        externalIdentifier: "+60123456789",
      });

      await repository.linkExternalIdentity({
        userId: userB,
        provider: "whatsapp",
        externalIdentifier: "+60198765432",
      });

      // Resolving primary user
      const resolvedA = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "+60123456789" });
      expect(resolvedA.resolved).toBe(true);
      if (resolvedA.resolved) {
        expect(resolvedA.user.id).toBe(userA);
        expect(resolvedA.user.role).toBe("primary");
      }

      // Resolving partner user
      const resolvedB = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "+60198765432" });
      expect(resolvedB.resolved).toBe(true);
      if (resolvedB.resolved) {
        expect(resolvedB.user.id).toBe(userB);
        expect(resolvedB.user.role).toBe("partner");
      }

      // Resolving unknown identifier
      const unknown = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "+60100000000" });
      expect(unknown.resolved).toBe(false);
      if (!unknown.resolved) {
        expect(unknown.reason).toBe("unknown_external_identity");
      }

      // Re-linking same mapping to same user is idempotent
      const relink = await repository.linkExternalIdentity({
        userId: userA,
        provider: "whatsapp",
        externalIdentifier: "+60123456789",
      });
      expect(relink.userId).toBe(userA);

      // Attempting to link already-mapped identifier to another user throws ConflictError
      await expect(
        repository.linkExternalIdentity({
          userId: userB,
          provider: "whatsapp",
          externalIdentifier: "+60123456789",
        }),
      ).rejects.toThrow("already mapped to another user");
    });

    it("retrieves household and membership for a user", async () => {
      const infoA = await repository.getHouseholdForUser(userA);
      expect(infoA).not.toBeNull();
      expect(infoA?.household.id).toBe(DEFAULT_HOUSEHOLD_ID);
      expect(infoA?.membership.userId).toBe(userA);
      expect(infoA?.membership.role).toBe("owner");

      const infoB = await repository.getHouseholdForUser(userB);
      expect(infoB).not.toBeNull();
      expect(infoB?.household.id).toBe(DEFAULT_HOUSEHOLD_ID);
      expect(infoB?.membership.userId).toBe(userB);
      expect(infoB?.membership.role).toBe("member");

      const unknown = await repository.getHouseholdForUser("00000000-0000-0000-0000-000000000099");
      expect(unknown).toBeNull();
    });

    it("links and resolves Google external identities safely", async () => {
      const googleSubA = "google-sub-primary-12345";
      const googleSubB = "google-sub-partner-67890";

      // 1. Link Google identity to primary user
      const linkedA = await repository.linkExternalIdentity({
        userId: userA,
        provider: "google",
        externalIdentifier: googleSubA,
        metadata: { email: "primary@example.com", name: "Primary User" },
      });
      expect(linkedA.userId).toBe(userA);
      expect(linkedA.provider).toBe("google");

      // 2. Resolve Google identity for primary user
      const resolvedA = await repository.resolveUser({ provider: "google", externalIdentifier: googleSubA });
      expect(resolvedA.resolved).toBe(true);
      if (resolvedA.resolved) {
        expect(resolvedA.user.id).toBe(userA);
      }

      // 3. Link Google identity to partner user
      const linkedB = await repository.linkExternalIdentity({
        userId: userB,
        provider: "google",
        externalIdentifier: googleSubB,
        metadata: { email: "partner@example.com", name: "Partner User" },
      });
      expect(linkedB.userId).toBe(userB);

      // 4. Attempting to link a second Google identity to userA throws ConflictError
      await expect(
        repository.linkExternalIdentity({
          userId: userA,
          provider: "google",
          externalIdentifier: "google-sub-primary-extra",
        }),
      ).rejects.toThrow("already linked to Google account");

      // 5. Attempting to link userA's Google account to userB throws ConflictError
      await expect(
        repository.linkExternalIdentity({
          userId: userB,
          provider: "google",
          externalIdentifier: googleSubA,
        }),
      ).rejects.toThrow("already mapped to another user");
    });

    it("maintains independent per-user settings", async () => {
      await repository.updateSettings(userA, { calorieTarget: 2600, proteinTargetG: 180 });
      await repository.updateSettings(userB, { calorieTarget: 1900, proteinTargetG: 130 });

      const settingsA = await repository.getSettings(userA);
      const settingsB = await repository.getSettings(userB);

      expect(settingsA.calorieTarget).toBe(2600);
      expect(settingsA.proteinTargetG).toBe(180);

      expect(settingsB.calorieTarget).toBe(1900);
      expect(settingsB.proteinTargetG).toBe(130);
    });

    it("strictly isolates meals, daily totals, and prevents cross-user meal reads", async () => {
      const mealA = await repository.createMeal(userA, {
        ...baseMeal,
        label: "User A Lunch",
        calories: { best: 800, low: 750, high: 850 },
        idempotencyKey: "meal-user-a-001",
      });

      const mealB = await repository.createMeal(userB, {
        ...baseMeal,
        label: "User B Lunch",
        calories: { best: 450, low: 400, high: 500 },
        idempotencyKey: "meal-user-b-001",
      });

      // User A can read own meal, but User B cannot read User A's meal
      expect((await repository.getMeal(userA, mealA.id)).id).toBe(mealA.id);
      await expect(repository.getMeal(userB, mealA.id)).rejects.toThrow("Meal not found");

      // User B can read own meal, but User A cannot read User B's meal
      expect((await repository.getMeal(userB, mealB.id)).id).toBe(mealB.id);
      await expect(repository.getMeal(userA, mealB.id)).rejects.toThrow("Meal not found");

      // Recent meals list only own meals
      const recentA = await repository.listRecentMeals(userA);
      expect(recentA.map((m) => m.id)).toContain(mealA.id);
      expect(recentA.map((m) => m.id)).not.toContain(mealB.id);

      const recentB = await repository.listRecentMeals(userB);
      expect(recentB.map((m) => m.id)).toContain(mealB.id);
      expect(recentB.map((m) => m.id)).not.toContain(mealA.id);

      // Daily nutrition computes totals independently
      const start = new Date("2026-08-14T00:00:00.000Z");
      const end = new Date("2026-08-15T00:00:00.000Z");

      const dailyA = await repository.dailyNutrition(userA, start, end);
      expect(dailyA.totals.caloriesBest).toBe(800);

      const dailyB = await repository.dailyNutrition(userB, start, end);
      expect(dailyB.totals.caloriesBest).toBe(450);
    });

    it("allows simultaneous active workouts for User A and User B while enforcing per-user active invariant", async () => {
      // User A starts active workout
      const workoutA = await repository.startWorkout(userA, {
        name: "User A Morning Push",
        idempotencyKey: "workout-user-a-001",
      });
      expect(workoutA.workout.status).toBe("active");

      // User B can simultaneously start active workout without conflict
      const workoutB = await repository.startWorkout(userB, {
        name: "User B Morning Cardio",
        idempotencyKey: "workout-user-b-001",
      });
      expect(workoutB.workout.status).toBe("active");

      // Both active workouts can be queried concurrently
      expect((await repository.getActiveWorkout(userA))?.workout.id).toBe(workoutA.workout.id);
      expect((await repository.getActiveWorkout(userB))?.workout.id).toBe(workoutB.workout.id);

      // User A attempting to start a second active workout throws ConflictError
      await expect(
        repository.startWorkout(userA, {
          name: "User A Second Workout",
          idempotencyKey: "workout-user-a-002",
        }),
      ).rejects.toThrow("already active");

      // User A adds sets and finishes workout
      await repository.addWorkoutSet(userA, workoutA.workout.id, {
        exerciseName: "Bench Press",
        weightKg: 90,
        reps: 5,
        idempotencyKey: "set-user-a-001",
      });
      await repository.finishWorkout(userA, workoutA.workout.id);
      expect(await repository.getActiveWorkout(userA)).toBeNull();

      // User B's workout is still active!
      expect((await repository.getActiveWorkout(userB))?.workout.id).toBe(workoutB.workout.id);

      // Now User A can start another workout since previous is finished
      const workoutA2 = await repository.startWorkout(userA, {
        name: "User A Evening Pull",
        idempotencyKey: "workout-user-a-003",
      });
      expect(workoutA2.workout.status).toBe("active");
    });

    it("enforces user ownership on pending meals: User B cannot view or confirm User A's pending meal", async () => {
      const pendingA = await repository.createPendingMeal(userA, {
        ...baseMeal,
        label: "User A Draft Bowl",
        scopeKey: "whatsapp:group",
        idempotencyKey: "pending-user-a-001",
        expiresInSeconds: 3600,
      });

      // User A can access draft
      expect((await repository.getPendingMeal(userA, pendingA.id, "whatsapp:group")).id).toBe(pendingA.id);

      // User B cannot get User A's pending meal
      await expect(repository.getPendingMeal(userB, pendingA.id, "whatsapp:group")).rejects.toThrow("not found");

      // User B cannot confirm User A's pending meal
      await expect(
        repository.confirmPendingMeal(userB, pendingA.id, { scopeKey: "whatsapp:group" }),
      ).rejects.toThrow("not found");

      // User A confirms own pending meal -> created meal has user_id = User A
      const confirmed = await repository.confirmPendingMeal(userA, pendingA.id, { scopeKey: "whatsapp:group" });
      expect(confirmed.userId).toBe(userA);
      expect(confirmed.label).toBe("User A Draft Bowl");
    });

    it("isolates idempotency across users for meals, pending meals, workouts, and workout sets", async () => {
      // 1. Meals: User A and User B can independently use the same idempotency key string
      const mealA = await repository.createMeal(userA, { ...baseMeal, label: "User A Lunch", idempotencyKey: "shared-meal-key" });
      const mealB = await repository.createMeal(userB, { ...baseMeal, label: "User B Lunch", idempotencyKey: "shared-meal-key" });
      expect(mealA.id).not.toBe(mealB.id);
      expect(mealA.userId).toBe(userA);
      expect(mealB.userId).toBe(userB);

      // Retries return each user's own meal
      const retryMealA = await repository.createMeal(userA, { ...baseMeal, label: "Should not replace A", idempotencyKey: "shared-meal-key" });
      expect(retryMealA.id).toBe(mealA.id);
      expect(retryMealA.label).toBe("User A Lunch");

      const retryMealB = await repository.createMeal(userB, { ...baseMeal, label: "Should not replace B", idempotencyKey: "shared-meal-key" });
      expect(retryMealB.id).toBe(mealB.id);
      expect(retryMealB.label).toBe("User B Lunch");

      // 2. Pending Meals: User A and User B can use identical scopeKey and idempotencyKey
      const pendingA = await repository.createPendingMeal(userA, {
        ...baseMeal,
        scopeKey: "whatsapp:shared-group",
        idempotencyKey: "shared-pending-key",
        expiresInSeconds: 3600,
      });
      const pendingB = await repository.createPendingMeal(userB, {
        ...baseMeal,
        label: "User B Draft",
        scopeKey: "whatsapp:shared-group",
        idempotencyKey: "shared-pending-key",
        expiresInSeconds: 3600,
      });
      expect(pendingA.id).not.toBe(pendingB.id);
      expect(pendingA.userId).toBe(userA);
      expect(pendingB.userId).toBe(userB);

      expect((await repository.getLatestPendingMeal(userA, "whatsapp:shared-group"))?.id).toBe(pendingA.id);
      expect((await repository.getLatestPendingMeal(userB, "whatsapp:shared-group"))?.id).toBe(pendingB.id);

      // 3. Workouts: User A and User B can use identical idempotencyKey
      const workoutA = await repository.startWorkout(userA, {
        name: "User A Push",
        idempotencyKey: "shared-workout-key",
      });
      const workoutB = await repository.startWorkout(userB, {
        name: "User B Pull",
        idempotencyKey: "shared-workout-key",
      });
      expect(workoutA.workout.id).not.toBe(workoutB.workout.id);
      expect(workoutA.workout.userId).toBe(userA);
      expect(workoutB.workout.userId).toBe(userB);

      const retryWorkoutA = await repository.startWorkout(userA, {
        name: "Should not replace",
        idempotencyKey: "shared-workout-key",
      });
      expect(retryWorkoutA.workout.id).toBe(workoutA.workout.id);

      const retryWorkoutB = await repository.startWorkout(userB, {
        name: "Should not replace",
        idempotencyKey: "shared-workout-key",
      });
      expect(retryWorkoutB.workout.id).toBe(workoutB.workout.id);

      // 4. Workout Sets: CRITICAL test for cross-user duplicate lookup
      const setA = await repository.addWorkoutSet(userA, workoutA.workout.id, {
        exerciseName: "Bench Press",
        weightKg: 80,
        reps: 8,
        idempotencyKey: "shared-set-key",
      });
      expect(setA.idempotencyKey).toBe("shared-set-key");

      const setB = await repository.addWorkoutSet(userB, workoutB.workout.id, {
        exerciseName: "Row",
        weightKg: 60,
        reps: 10,
        idempotencyKey: "shared-set-key",
      });
      expect(setB.idempotencyKey).toBe("shared-set-key");

      // Verify User B received their own set, NOT User A's set!
      expect(setB.id).not.toBe(setA.id);
      expect(setB.weightKg).toBe(60);
      expect(setA.weightKg).toBe(80);

      // Retries resolve only within the caller's workout context
      const retrySetA = await repository.addWorkoutSet(userA, workoutA.workout.id, {
        exerciseName: "Bench Press",
        weightKg: 999,
        reps: 999,
        idempotencyKey: "shared-set-key",
      });
      expect(retrySetA.id).toBe(setA.id);
      expect(retrySetA.weightKg).toBe(80);

      const retrySetB = await repository.addWorkoutSet(userB, workoutB.workout.id, {
        exerciseName: "Row",
        weightKg: 999,
        reps: 999,
        idempotencyKey: "shared-set-key",
      });
      expect(retrySetB.id).toBe(setB.id);
      expect(retrySetB.weightKg).toBe(60);

      // Cross-workout set addition is blocked
      await expect(
        repository.addWorkoutSet(userB, workoutA.workout.id, {
          exerciseName: "Bench Press",
          weightKg: 50,
          reps: 5,
          idempotencyKey: "tamper-key",
        }),
      ).rejects.toThrow("Workout not found");
    });

    it("protects health history from user delete cascades with RESTRICT", async () => {
      // User A logs a meal
      await repository.createMeal(userA, baseMeal);

      // Attempting to delete User A must fail with foreign key constraint violation (ON DELETE RESTRICT)
      await expect(pg.query("DELETE FROM users WHERE id = $1", [userA])).rejects.toThrow();

      // Core historical health data remains completely intact
      const mealsA = await repository.listRecentMeals(userA);
      expect(mealsA).toHaveLength(1);

      // User B finishes a workout
      const wb = await repository.startWorkout(userB, { name: "Leg Day", idempotencyKey: "wb-hist-01" });
      await repository.finishWorkout(userB, wb.workout.id);

      // Attempting to delete User B must also fail with foreign key violation
      await expect(pg.query("DELETE FROM users WHERE id = $1", [userB])).rejects.toThrow();

      const historyB = await repository.workoutHistory(userB);
      expect(historyB).toHaveLength(1);

      // Routine user deactivation via active = false succeeds and preserves history
      await pg.query("UPDATE users SET active = false WHERE id = $1", [userA]);
      const deactivatedUser = await repository.getUser(userA);
      expect(deactivatedUser.active).toBe(false);
      expect(await repository.listRecentMeals(userA)).toHaveLength(1);
    });

    it("enforces safe preset updates with ownership isolation and calorie range validation", async () => {
      const presetA = await repository.savePreset(userA, "Oatmeal Bowl", baseMeal);
      expect(presetA.userId).toBe(userA);

      // User B cannot mutate User A's preset
      await expect(
        repository.updatePreset(userB, presetA.id, { label: "Hacked by User B" }),
      ).rejects.toThrow("Food preset not found");

      // User B cannot delete User A's preset
      await expect(
        repository.deletePreset(userB, presetA.id),
      ).rejects.toThrow("Food preset not found");

      // Calorie range validation: low <= best <= high
      await expect(
        repository.updatePreset(userA, presetA.id, { caloriesBest: 300 }),
      ).rejects.toThrow("Calorie ranges must satisfy low <= best <= high");

      await expect(
        repository.updatePreset(userA, presetA.id, { caloriesLow: 600, caloriesHigh: 400 }),
      ).rejects.toThrow("Calorie ranges must satisfy low <= best <= high");

      // Valid update applies safely
      const updated = await repository.updatePreset(userA, presetA.id, {
        caloriesBest: 520,
        caloriesLow: 480,
        caloriesHigh: 580,
        label: "Updated Oatmeal Bowl",
      });
      expect(updated.label).toBe("Updated Oatmeal Bowl");
      expect(updated.caloriesBest).toBe(520);
      expect(updated.userId).toBe(userA);
    });

    it("retrieves together dashboard data for household members with authorization and privacy isolation", async () => {
      const userA = primaryUserId;
      const userB = DEFAULT_PARTNER_USER_ID;
      const dateStr = "2026-08-14";
      const timezone = "Asia/Kuala_Lumpur";

      // User A creates a confirmed meal and a finished workout
      await repository.createMeal(userA, {
        ...baseMeal,
        label: "User A Breakfast",
        occurredAt: new Date("2026-08-14T01:00:00.000Z"),
        calories: { best: 450, low: 400, high: 500 },
        macros: { proteinG: 25, carbsG: 40, fatG: 15, fiberG: 3 },
        idempotencyKey: "meal-user-a-1",
      });

      const workoutA = await repository.startWorkout(userA, {
        name: "Morning Run User A",
        startedAt: new Date("2026-08-14T02:00:00.000Z"),
        idempotencyKey: "workout-user-a-1",
      });
      await repository.finishWorkout(userA, workoutA.workout.id, new Date("2026-08-14T03:00:00.000Z"));

      // User A also starts an unfinished workout (should NOT appear on together dashboard)
      await repository.startWorkout(userA, {
        name: "Unfinished Workout User A",
        startedAt: new Date("2026-08-14T04:00:00.000Z"),
        idempotencyKey: "workout-user-a-2",
      });

      // User B creates a confirmed meal and a finished workout
      await repository.createMeal(userB, {
        ...baseMeal,
        label: "User B Lunch",
        occurredAt: new Date("2026-08-14T05:00:00.000Z"),
        calories: { best: 650, low: 600, high: 700 },
        macros: { proteinG: 45, carbsG: 60, fatG: 20, fiberG: 6 },
        idempotencyKey: "meal-user-b-1",
      });

      const workoutB = await repository.startWorkout(userB, {
        name: "Afternoon Lift User B",
        startedAt: new Date("2026-08-14T06:00:00.000Z"),
        idempotencyKey: "workout-user-b-1",
      });
      await repository.finishWorkout(userB, workoutB.workout.id, new Date("2026-08-14T07:00:00.000Z"));

      // User B creates a draft pending meal (should NOT appear on together dashboard)
      await repository.createPendingMeal(userB, {
        rawUserText: "Unconfirmed protein shake",
        scopeKey: "openclaw:whatsapp:peer-b",
        idempotencyKey: "draft-user-b-1",
        label: "Draft Shake",
        items: [{ name: "Protein powder", portionDescription: "1 scoop" }],
        calories: { best: 150, low: 140, high: 160 },
        macros: { proteinG: 25, carbsG: 3, fatG: 2, fiberG: 1 },
        confidence: "high",
        uncertaintyReasons: [],
        occurredAt: new Date("2026-08-14T06:00:00.000Z"),
        source: "text",
        expiresInSeconds: 7200,
      });

      // Query together dashboard as User A
      const resultA = await repository.getTogetherDashboardData(userA, dateStr, timezone, 7);
      expect(resultA).not.toBeNull();
      expect(resultA?.household.id).toBe(DEFAULT_HOUSEHOLD_ID);
      expect(resultA?.date).toBe(dateStr);
      expect(resultA?.timezone).toBe(timezone);
      expect(resultA?.members).toHaveLength(2);

      // First member should be the caller (User A)
      const memberA = resultA!.members[0]!;
      expect(memberA.userId).toBe(userA);
      expect(memberA.isCaller).toBe(true);
      expect(memberA.daily.calories).toBe(450);
      expect(memberA.daily.proteinG).toBe(25);
      expect(memberA.daily.mealCount).toBe(1);
      expect(memberA.daily.meals[0]!.label).toBe("User A Breakfast");
      expect(memberA.daily.workouts).toHaveLength(1);
      expect(memberA.daily.workouts[0]!.name).toBe("Morning Run User A");

      // Second member should be partner (User B)
      const memberB = resultA!.members[1]!;
      expect(memberB.userId).toBe(userB);
      expect(memberB.isCaller).toBe(false);
      expect(memberB.daily.calories).toBe(650);
      expect(memberB.daily.proteinG).toBe(45);
      expect(memberB.daily.mealCount).toBe(1);
      expect(memberB.daily.meals[0]!.label).toBe("User B Lunch");
      expect(memberB.daily.workouts).toHaveLength(1);
      expect(memberB.daily.workouts[0]!.name).toBe("Afternoon Lift User B");

      // Now query together dashboard as User B - caller ordering should flip
      const resultB = await repository.getTogetherDashboardData(userB, dateStr, timezone, 7);
      expect(resultB!.members[0]!.userId).toBe(userB);
      expect(resultB!.members[0]!.isCaller).toBe(true);
      expect(resultB!.members[1]!.userId).toBe(userA);
      expect(resultB!.members[1]!.isCaller).toBe(false);

      // Outsider User C (not in household) returns null
      const outsiderUserId = "00000000-0000-0000-0000-000000000099";
      const resultOutsider = await repository.getTogetherDashboardData(outsiderUserId, dateStr, timezone, 7);
      expect(resultOutsider).toBeNull();
    });

    it("strictly isolates data between households using real multi-household fixtures", async () => {
      const userA = primaryUserId;
      const userB = DEFAULT_PARTNER_USER_ID;
      const userC = "00000000-0000-0000-0000-000000000030";
      const household2Id = "00000000-0000-0000-0000-000000000010";
      const dateStr = "2026-08-14";
      const timezone = "Asia/Kuala_Lumpur";

      // Seed Household 2 and User C
      await pg.exec(`
        INSERT INTO households (id, name) VALUES ('${household2Id}', 'Second Household');
        INSERT INTO users (id, display_name, role, active) VALUES ('${userC}', 'User C', 'primary', true);
        INSERT INTO household_members (household_id, user_id, role) VALUES ('${household2Id}', '${userC}', 'primary');
      `);

      // User A logs a meal in Household 1
      await repository.createMeal(userA, {
        ...baseMeal,
        label: "Household 1 Meal",
        occurredAt: new Date("2026-08-14T02:00:00.000Z"),
        calories: { best: 500, low: 450, high: 550 },
        idempotencyKey: "meal-h1-1",
      });

      // User C logs a private meal in Household 2
      await repository.createMeal(userC, {
        ...baseMeal,
        label: "Household 2 Private Meal",
        occurredAt: new Date("2026-08-14T03:00:00.000Z"),
        calories: { best: 850, low: 800, high: 900 },
        idempotencyKey: "meal-h2-1",
      });

      // User C queries together dashboard: should only see Household 2 and User C
      const resultC = await repository.getTogetherDashboardData(userC, dateStr, timezone, 7);
      expect(resultC).not.toBeNull();
      expect(resultC?.household.id).toBe(household2Id);
      expect(resultC?.household.name).toBe("Second Household");
      expect(resultC?.members).toHaveLength(1);
      expect(resultC?.members[0]!.userId).toBe(userC);
      expect(resultC?.members[0]!.daily.meals[0]!.label).toBe("Household 2 Private Meal");

      // User A queries together dashboard: should only see Household 1 (User A and User B), not User C
      const resultA = await repository.getTogetherDashboardData(userA, dateStr, timezone, 7);
      expect(resultA).not.toBeNull();
      expect(resultA?.household.id).toBe(DEFAULT_HOUSEHOLD_ID);
      const userIdsInH1 = resultA?.members.map((m) => m.userId);
      expect(userIdsInH1).toContain(userA);
      expect(userIdsInH1).toContain(userB);
      expect(userIdsInH1).not.toContain(userC);

      const allH1MealLabels = resultA?.members.flatMap((m) => m.daily.meals.map((meal) => meal.label));
      expect(allH1MealLabels).toContain("Household 1 Meal");
      expect(allH1MealLabels).not.toContain("Household 2 Private Meal");
    });

    it("excludes inactive partner from household members and rejects inactive caller", async () => {
      const userA = primaryUserId;
      const userB = DEFAULT_PARTNER_USER_ID;
      const dateStr = "2026-08-14";
      const timezone = "Asia/Kuala_Lumpur";

      // Mark User B inactive
      await pg.exec(`UPDATE users SET active = false WHERE id = '${userB}'`);

      // Active User A queries together dashboard: partner is inactive so members length is 1
      const resultA = await repository.getTogetherDashboardData(userA, dateStr, timezone, 7);
      expect(resultA).not.toBeNull();
      expect(resultA?.members).toHaveLength(1);
      expect(resultA?.members[0]!.userId).toBe(userA);

      // Inactive User B queries together dashboard: caller is inactive so returns null
      const resultB = await repository.getTogetherDashboardData(userB, dateStr, timezone, 7);
      expect(resultB).toBeNull();

      // Restore User B active
      await pg.exec(`UPDATE users SET active = true WHERE id = '${userB}'`);
    });

    it("revokes access immediately when household membership is deleted", async () => {
      const userA = primaryUserId;
      const userB = DEFAULT_PARTNER_USER_ID;
      const dateStr = "2026-08-14";
      const timezone = "Asia/Kuala_Lumpur";

      // Delete User B's household membership
      await pg.exec(`DELETE FROM household_members WHERE user_id = '${userB}'`);

      // User B queries together dashboard: returns null (no household)
      const resultB = await repository.getTogetherDashboardData(userB, dateStr, timezone, 7);
      expect(resultB).toBeNull();

      // User A queries together dashboard: only User A remains
      const resultA = await repository.getTogetherDashboardData(userA, dateStr, timezone, 7);
      expect(resultA).not.toBeNull();
      expect(resultA?.members).toHaveLength(1);
      expect(resultA?.members[0]!.userId).toBe(userA);

      // Restore User B membership
      await pg.exec(`INSERT INTO household_members (household_id, user_id, role) VALUES ('${DEFAULT_HOUSEHOLD_ID}', '${userB}', 'partner')`);
    });

    it("ensures midnight boundary consistency across callers with different stored timezones", async () => {
      const userA = primaryUserId;
      const userB = DEFAULT_PARTNER_USER_ID;
      const viewingTimezone = "Asia/Kuala_Lumpur";

      // User A has stored timezone Asia/Kuala_Lumpur; User B has stored timezone UTC
      await repository.updateSettings(userA, { timezone: "Asia/Kuala_Lumpur" });
      await repository.updateSettings(userB, { timezone: "UTC" });

      // User A logs a 300 kcal meal at 2026-09-10T16:30:00Z
      // In Asia/Kuala_Lumpur (+08:00), this is 2026-09-11 00:30:00
      // In UTC, this is 2026-09-10 16:30:00
      await repository.createMeal(userA, {
        ...baseMeal,
        label: "Late Night Snack",
        occurredAt: new Date("2026-09-10T16:30:00.000Z"),
        calories: { best: 300, low: 280, high: 320 },
        idempotencyKey: "meal-midnight-a-1",
      });

      // User A calls Together for 2026-09-11 with viewing timezone Asia/Kuala_Lumpur
      const resultA = await repository.getTogetherDashboardData(userA, "2026-09-11", viewingTimezone, 7);
      expect(resultA).not.toBeNull();
      const memberAFromA = resultA?.members.find((m) => m.userId === userA);
      expect(memberAFromA?.daily.calories).toBe(300);
      expect(memberAFromA?.daily.mealCount).toBe(1);

      // User B calls Together for 2026-09-11 with viewing timezone Asia/Kuala_Lumpur
      const resultB = await repository.getTogetherDashboardData(userB, "2026-09-11", viewingTimezone, 7);
      expect(resultB).not.toBeNull();
      const memberAFromB = resultB?.members.find((m) => m.userId === userA);
      // Midnight-boundary divergence eliminated: User B sees the exact same 300 kcal total for User A!
      expect(memberAFromB?.daily.calories).toBe(300);
      expect(memberAFromB?.daily.mealCount).toBe(1);
    });

    it("does not expose private meal notes, rawUserText, or auth credentials in together response", async () => {
      const userA = primaryUserId;
      const userB = DEFAULT_PARTNER_USER_ID;

      await repository.createMeal(userA, {
        ...baseMeal,
        label: "Confidential Meal",
        rawUserText: "private raw user text with sensitive medical note",
        occurredAt: new Date("2026-08-14T04:00:00.000Z"),
        calories: { best: 400, low: 380, high: 420 },
        idempotencyKey: "meal-private-1",
      });

      const resultB = await repository.getTogetherDashboardData(userB, "2026-08-14", "Asia/Kuala_Lumpur", 7);
      const memberA = resultB?.members.find((m) => m.userId === userA);
      const meal = memberA?.daily.meals.find((m) => m.label === "Confidential Meal");
      expect(meal).toBeDefined();

      const mealRecord = meal as Record<string, unknown>;
      expect(mealRecord.rawUserText).toBeUndefined();
      expect(mealRecord.uncertaintyReasons).toBeUndefined();
      expect(mealRecord.source).toBeUndefined();
      expect(mealRecord.idempotencyKey).toBeUndefined();
      expect(mealRecord.notes).toBeUndefined();
    });

    it("reports ready on current schema and fails if pre-0004 schema is present", async () => {
      // 1. Current schema (all migrations 0000-0004 applied) => ready
      await expect(repository.checkReady()).resolves.toBe(true);

      // 2. Pre-0004 schema (database reachable but missing migration 0004) => NOT ready
      const pre0004Pg = new PGlite();
      try {
        for (const name of [
          "0000_fuzzy_doorman.sql",
          "0001_cuddly_pending_meals.sql",
          "0002_mobile_product_foundation.sql",
          "0003_scope_pending_meals.sql",
        ]) {
          const migrationSql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
          await pre0004Pg.exec(migrationSql.replaceAll("--> statement-breakpoint", ""));
        }
        const pre0004Db = drizzle(pre0004Pg, { schema }) as unknown as HealthDatabase;
        const pre0004Repo = new HealthRepository(pre0004Db);

        await expect(pre0004Repo.checkReady()).rejects.toThrow();
      } finally {
        await pre0004Pg.close();
      }
    });
  });
});

