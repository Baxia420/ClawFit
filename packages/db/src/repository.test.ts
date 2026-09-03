import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

      const fromLid = await repository.resolveUser({ provider: "whatsapp", externalIdentifier: "12345678901234@lid" });
      expect(fromLid.resolved).toBe(true);
      if (fromLid.resolved) {
        expect(fromLid.user.id).toBe(userA);
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

