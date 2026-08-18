import { and, asc, desc, eq, gt, gte, ilike, isNull, lt, sql } from "drizzle-orm";
import {
  estimatedOneRepMax,
  sumNutrition,
  workoutVolume,
  type MealInput,
  type MealPatch,
  type NotificationPreferenceInput,
  type PendingMealInput,
  type PendingMealPatch,
  type SettingsPatch,
  type WorkoutSetInput,
  type WorkoutSetPatch,
} from "@clawfit/health-core";
import type { HealthDatabase } from "./client.js";
import { exercises, foodPresets, mealItems, meals, notificationPreferences, pendingMealEstimates, userSettings, workouts, workoutSets } from "./schema.js";

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class ConflictError extends Error {
  override name = "ConflictError";
}

export class HealthRepository {
  constructor(private readonly db: HealthDatabase) {}

  async createMeal(input: MealInput) {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.meals.findFirst({ where: eq(meals.idempotencyKey, input.idempotencyKey) });
      if (existing) return this.getMealWith(tx, existing.id);
      const [created] = await tx
        .insert(meals)
        .values({
          occurredAt: input.occurredAt,
          label: input.label,
          caloriesBest: input.calories.best,
          caloriesLow: input.calories.low,
          caloriesHigh: input.calories.high,
          proteinG: input.macros.proteinG,
          carbsG: input.macros.carbsG,
          fatG: input.macros.fatG,
          fiberG: input.macros.fiberG,
          confidence: input.confidence,
          uncertaintyReasons: input.uncertaintyReasons,
          source: input.source,
          rawUserText: input.rawUserText,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!created) throw new Error("Meal insert returned no record");
      if (input.items.length > 0) {
        await tx.insert(mealItems).values(input.items.map((item) => ({ mealId: created.id, name: item.name, portionDescription: item.portionDescription })));
      }
      await tx
        .update(pendingMealEstimates)
        .set({ confirmed: true, confirmedAt: new Date(), mealId: created.id, updatedAt: new Date() })
        .where(eq(pendingMealEstimates.idempotencyKey, input.idempotencyKey));
      return this.getMealWith(tx, created.id);
    });
  }

  async createPendingMeal(input: PendingMealInput) {
    const existing = await this.db.query.pendingMealEstimates.findFirst({
      where: eq(pendingMealEstimates.idempotencyKey, input.idempotencyKey),
    });
    if (existing) return existing;
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? 7_200) * 1000);
    const [created] = await this.db
      .insert(pendingMealEstimates)
      .values({
        label: input.label,
        items: input.items,
        caloriesBest: input.calories.best,
        caloriesLow: input.calories.low,
        caloriesHigh: input.calories.high,
        proteinG: input.macros.proteinG,
        carbsG: input.macros.carbsG,
        fatG: input.macros.fatG,
        fiberG: input.macros.fiberG,
        confidence: input.confidence,
        uncertaintyReasons: input.uncertaintyReasons,
        source: input.source,
        rawUserText: input.rawUserText ?? null,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        confirmed: false,
        expiresAt,
      })
      .returning();
    if (!created) throw new Error("Pending meal insert returned no record");
    return created;
  }

  async getPendingMeal(id: string) {
    const pending = await this.db.query.pendingMealEstimates.findFirst({
      where: eq(pendingMealEstimates.id, id),
    });
    if (!pending) throw new NotFoundError("Pending meal estimate not found");
    return pending;
  }

  async getLatestPendingMeal(now = new Date()) {
    const pending = await this.db.query.pendingMealEstimates.findFirst({
      where: and(
        eq(pendingMealEstimates.confirmed, false),
        isNull(pendingMealEstimates.cancelledAt),
        gt(pendingMealEstimates.expiresAt, now),
      ),
      orderBy: desc(pendingMealEstimates.createdAt),
    });
    return pending ?? null;
  }

  async updatePendingMeal(id: string, patch: PendingMealPatch) {
    const current = await this.getPendingMeal(id);
    if (current.confirmed) throw new ConflictError("A confirmed meal draft cannot be edited");
    if (current.cancelledAt) throw new ConflictError("A cancelled meal draft cannot be edited");
    const nextLow = patch.caloriesLow ?? current.caloriesLow;
    const nextBest = patch.caloriesBest ?? current.caloriesBest;
    const nextHigh = patch.caloriesHigh ?? current.caloriesHigh;
    if (nextLow > nextBest || nextBest > nextHigh) {
      throw new ConflictError("Calorie range must satisfy low <= best <= high");
    }
    const [updated] = await this.db
      .update(pendingMealEstimates)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(pendingMealEstimates.id, id))
      .returning();
    if (!updated) throw new NotFoundError("Pending meal estimate not found");
    return updated;
  }

  async cancelPendingMeal(id: string) {
    const current = await this.getPendingMeal(id);
    if (current.confirmed) throw new ConflictError("A confirmed meal draft cannot be cancelled");
    if (current.cancelledAt) return current;
    const [cancelled] = await this.db
      .update(pendingMealEstimates)
      .set({ cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(pendingMealEstimates.id, id))
      .returning();
    if (!cancelled) throw new NotFoundError("Pending meal estimate not found");
    return cancelled;
  }

  async confirmPendingMeal(id: string, options: { occurredAt?: Date | undefined; idempotencyKey?: string | undefined } = {}) {

    return this.db.transaction(async (tx) => {
      const pending = await tx.query.pendingMealEstimates.findFirst({
        where: eq(pendingMealEstimates.id, id),
      });
      if (!pending) throw new NotFoundError("Pending meal estimate not found");
      if (pending.cancelledAt) throw new ConflictError("A cancelled meal draft cannot be confirmed");
      if (pending.confirmed && pending.mealId) {
        const existingMeal = await this.getMealWith(tx, pending.mealId);
        if (existingMeal) return existingMeal;
      }
      const mealIdempotencyKey = options.idempotencyKey ?? `confirmed_${pending.idempotencyKey}`;
      const existingByUq = await tx.query.meals.findFirst({
        where: eq(meals.idempotencyKey, mealIdempotencyKey),
      });
      if (existingByUq) {
        await tx
          .update(pendingMealEstimates)
          .set({ confirmed: true, confirmedAt: new Date(), mealId: existingByUq.id, updatedAt: new Date() })
          .where(eq(pendingMealEstimates.id, id));
        return this.getMealWith(tx, existingByUq.id);
      }

      const [created] = await tx
        .insert(meals)
        .values({
          occurredAt: options.occurredAt ?? pending.occurredAt,
          label: pending.label,
          caloriesBest: pending.caloriesBest,
          caloriesLow: pending.caloriesLow,
          caloriesHigh: pending.caloriesHigh,
          proteinG: pending.proteinG,
          carbsG: pending.carbsG,
          fatG: pending.fatG,
          fiberG: pending.fiberG,
          confidence: pending.confidence,
          uncertaintyReasons: pending.uncertaintyReasons,
          source: pending.source,
          rawUserText: pending.rawUserText,
          idempotencyKey: mealIdempotencyKey,
        })
        .onConflictDoNothing({ target: meals.idempotencyKey })
        .returning();

      const persisted = created ?? await tx.query.meals.findFirst({ where: eq(meals.idempotencyKey, mealIdempotencyKey) });
      if (!persisted) throw new Error("Confirmed meal could not be resolved");

      const items = Array.isArray(pending.items) ? pending.items : [];
      if (created && items.length > 0) {
        await tx.insert(mealItems).values(
          items.map((item) => ({
            mealId: persisted.id,
            name: item.name,
            portionDescription: item.portionDescription,
          })),
        );
      }

      await tx
        .update(pendingMealEstimates)
        .set({ confirmed: true, confirmedAt: new Date(), mealId: persisted.id, updatedAt: new Date() })
        .where(eq(pendingMealEstimates.id, id));

      return this.getMealWith(tx, persisted.id);
    });
  }


  async getMeal(id: string) {
    const result = await this.getMealWith(this.db, id);
    if (!result) throw new NotFoundError("Meal not found");
    return result;
  }

  async listRecentMeals(limit = 20) {
    const rows = await this.db.select().from(meals).orderBy(desc(meals.occurredAt)).limit(limit);
    return Promise.all(rows.map((row) => this.getMealWith(this.db, row.id)));
  }

  async updateMeal(id: string, patch: MealPatch) {
    const current = await this.db.query.meals.findFirst({ where: eq(meals.id, id) });
    if (!current) throw new NotFoundError("Meal not found");
    const nextLow = patch.caloriesLow ?? current.caloriesLow;
    const nextBest = patch.caloriesBest ?? current.caloriesBest;
    const nextHigh = patch.caloriesHigh ?? current.caloriesHigh;
    if (nextLow > nextBest || nextBest > nextHigh) {
      throw new ConflictError("Calorie range must satisfy low <= best <= high");
    }
    const [updated] = await this.db
      .update(meals)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(meals.id, id))
      .returning();
    if (!updated) throw new NotFoundError("Meal not found");
    return this.getMeal(id);
  }

  async deleteMeal(id: string) {
    const [deleted] = await this.db.delete(meals).where(eq(meals.id, id)).returning({ id: meals.id });
    if (!deleted) throw new NotFoundError("Meal not found");
    return deleted;
  }

  async dailyNutrition(start: Date, end: Date) {
    const rows = await this.db.select().from(meals).where(and(gte(meals.occurredAt, start), lt(meals.occurredAt, end))).orderBy(asc(meals.occurredAt));
    return { date: start.toISOString().slice(0, 10), totals: sumNutrition(rows), meals: rows };
  }

  async nutritionTrend(start: Date, end: Date) {
    return this.db.execute(sql`
      select date_trunc('day', occurred_at) as day,
        sum(calories_best)::float as calories_best,
        sum(calories_low)::float as calories_low,
        sum(calories_high)::float as calories_high,
        sum(protein_g)::float as protein_g
      from ${meals}
      where occurred_at >= ${start} and occurred_at < ${end}
      group by 1 order by 1 asc
    `);
  }

  async savePreset(name: string, estimate: MealInput) {
    const normalizedName = normalizeName(name);
    const [preset] = await this.db
      .insert(foodPresets)
      .values({
        name,
        normalizedName,
        label: estimate.label,
        caloriesBest: estimate.calories.best,
        caloriesLow: estimate.calories.low,
        caloriesHigh: estimate.calories.high,
        proteinG: estimate.macros.proteinG,
        carbsG: estimate.macros.carbsG,
        fatG: estimate.macros.fatG,
        fiberG: estimate.macros.fiberG,
        confidence: estimate.confidence,
        uncertaintyReasons: estimate.uncertaintyReasons,
      })
      .onConflictDoUpdate({
        target: foodPresets.normalizedName,
        set: {
          name,
          label: estimate.label,
          caloriesBest: estimate.calories.best,
          caloriesLow: estimate.calories.low,
          caloriesHigh: estimate.calories.high,
          proteinG: estimate.macros.proteinG,
          carbsG: estimate.macros.carbsG,
          fatG: estimate.macros.fatG,
          fiberG: estimate.macros.fiberG,
          confidence: estimate.confidence,
          uncertaintyReasons: estimate.uncertaintyReasons,
          updatedAt: new Date(),
        },
      })
      .returning();
    return preset;
  }

  async findPresets(query: string) {
    return this.db.select().from(foodPresets).where(ilike(foodPresets.normalizedName, `%${normalizeName(query)}%`)).limit(10);
  }

  async updatePreset(id: string, patch: Partial<typeof foodPresets.$inferInsert>) {
    const values = { ...patch, ...(patch.name ? { normalizedName: normalizeName(patch.name) } : {}), updatedAt: new Date() };
    const [updated] = await this.db.update(foodPresets).set(values).where(eq(foodPresets.id, id)).returning();
    if (!updated) throw new NotFoundError("Food preset not found");
    return updated;
  }

  async deletePreset(id: string) {
    const [deleted] = await this.db.delete(foodPresets).where(eq(foodPresets.id, id)).returning({ id: foodPresets.id });
    if (!deleted) throw new NotFoundError("Food preset not found");
    return deleted;
  }

  async startWorkout(input: { name: string; startedAt?: Date; idempotencyKey: string }) {
    const existing = await this.db.query.workouts.findFirst({ where: eq(workouts.idempotencyKey, input.idempotencyKey) });
    if (existing) return this.getWorkout(existing.id);
    const active = await this.getActiveWorkout();
    if (active) throw new ConflictError(`Workout ${active.workout.id} is already active`);
    const [created] = await this.db
      .insert(workouts)
      .values({ name: input.name, startedAt: input.startedAt ?? new Date(), idempotencyKey: input.idempotencyKey })
      .returning();
    if (!created) throw new Error("Workout insert returned no record");
    return this.getWorkout(created.id);
  }

  async getActiveWorkout() {
    const active = await this.db.query.workouts.findFirst({ where: eq(workouts.status, "active"), orderBy: desc(workouts.startedAt) });
    return active ? this.getWorkout(active.id) : null;
  }

  async addWorkoutSet(workoutId: string, input: WorkoutSetInput) {
    return this.db.transaction(async (tx) => {
      const workout = await tx.query.workouts.findFirst({ where: eq(workouts.id, workoutId) });
      if (!workout) throw new NotFoundError("Workout not found");
      if (workout.status !== "active") throw new ConflictError("Cannot add a set to a finished workout");
      const duplicate = await tx.query.workoutSets.findFirst({ where: eq(workoutSets.idempotencyKey, input.idempotencyKey) });
      if (duplicate) return duplicate;
      const normalizedName = normalizeName(input.exerciseName);
      let exercise = await tx.query.exercises.findFirst({ where: and(eq(exercises.workoutId, workoutId), eq(exercises.normalizedName, normalizedName)) });
      if (!exercise) {
        const positionRows = await tx.select({ count: sql<number>`count(*)::int` }).from(exercises).where(eq(exercises.workoutId, workoutId));
        [exercise] = await tx.insert(exercises).values({ workoutId, name: input.exerciseName, normalizedName, position: positionRows[0]?.count ?? 0 }).returning();
      }
      if (!exercise) throw new Error("Exercise insert returned no record");
      const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(workoutSets).where(eq(workoutSets.exerciseId, exercise.id));
      const [created] = await tx
        .insert(workoutSets)
        .values({
          exerciseId: exercise.id,
          setNumber: (countRows[0]?.count ?? 0) + 1,
          weightKg: input.weightKg,
          reps: input.reps,
          rpe: input.rpe ?? null,
          notes: input.notes ?? null,
          occurredAt: input.occurredAt ?? new Date(),
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!created) throw new Error("Set insert returned no record");
      return created;
    });
  }

  async updateWorkoutSet(id: string, patch: WorkoutSetPatch) {
    const [updated] = await this.db.update(workoutSets).set({ ...patch, updatedAt: new Date() }).where(eq(workoutSets.id, id)).returning();
    if (!updated) throw new NotFoundError("Workout set not found");
    return { ...updated, estimatedOneRepMax: estimatedOneRepMax(updated.weightKg, updated.reps) };
  }

  async deleteWorkoutSet(id: string) {
    const [deleted] = await this.db.delete(workoutSets).where(eq(workoutSets.id, id)).returning({ id: workoutSets.id, exerciseId: workoutSets.exerciseId });
    if (!deleted) throw new NotFoundError("Workout set not found");
    const remaining = await this.db.select().from(workoutSets).where(eq(workoutSets.exerciseId, deleted.exerciseId)).orderBy(asc(workoutSets.setNumber));
    for (const [index, set] of remaining.entries()) {
      if (set.setNumber !== index + 1) await this.db.update(workoutSets).set({ setNumber: index + 1 }).where(eq(workoutSets.id, set.id));
    }
    return { id: deleted.id };
  }

  async finishWorkout(id: string, finishedAt = new Date()) {
    const [updated] = await this.db.update(workouts).set({ status: "finished", finishedAt, updatedAt: new Date() }).where(eq(workouts.id, id)).returning();
    if (!updated) throw new NotFoundError("Workout not found");
    return this.getWorkout(id);
  }

  async getWorkout(id: string) {
    const workout = await this.db.query.workouts.findFirst({ where: eq(workouts.id, id) });
    if (!workout) throw new NotFoundError("Workout not found");
    const exerciseRows = await this.db.select().from(exercises).where(eq(exercises.workoutId, id)).orderBy(asc(exercises.position));
    const hydrated = await Promise.all(
      exerciseRows.map(async (exercise) => {
        const sets = await this.db.select().from(workoutSets).where(eq(workoutSets.exerciseId, exercise.id)).orderBy(asc(workoutSets.setNumber));
        return { ...exercise, sets: sets.map((set) => ({ ...set, estimatedOneRepMax: estimatedOneRepMax(set.weightKg, set.reps) })) };
      }),
    );
    const flatSets = hydrated.flatMap((exercise) => exercise.sets);
    return { workout, exercises: hydrated, volumeKg: workoutVolume(flatSets), setCount: flatSets.length };
  }

  async workoutHistory(limit = 20) {
    const rows = await this.db.select({ id: workouts.id }).from(workouts).orderBy(desc(workouts.startedAt)).limit(limit);
    return Promise.all(rows.map((row) => this.getWorkout(row.id)));
  }

  async previousExercisePerformance(name: string, before = new Date()) {
    const exercise = await this.db
      .select({ exerciseId: exercises.id, workoutId: workouts.id })
      .from(exercises)
      .innerJoin(workouts, eq(exercises.workoutId, workouts.id))
      .where(and(eq(exercises.normalizedName, normalizeName(name)), lt(workouts.startedAt, before)))
      .orderBy(desc(workouts.startedAt))
      .limit(1);
    if (!exercise[0]) return null;
    const sets = await this.db.select().from(workoutSets).where(eq(workoutSets.exerciseId, exercise[0].exerciseId)).orderBy(asc(workoutSets.setNumber));
    return { workoutId: exercise[0].workoutId, sets: sets.map((set) => ({ ...set, estimatedOneRepMax: estimatedOneRepMax(set.weightKg, set.reps) })) };
  }

  async exerciseHistory(name: string, limit = 100) {
    const rows = await this.db
      .select({ set: workoutSets, workout: workouts })
      .from(workoutSets)
      .innerJoin(exercises, eq(workoutSets.exerciseId, exercises.id))
      .innerJoin(workouts, eq(exercises.workoutId, workouts.id))
      .where(eq(exercises.normalizedName, normalizeName(name)))
      .orderBy(desc(workoutSets.occurredAt))
      .limit(limit);
    return rows.map(({ set, workout }) => ({ ...set, workoutName: workout.name, workoutId: workout.id, estimatedOneRepMax: estimatedOneRepMax(set.weightKg, set.reps) }));
  }

  async getSettings() {
    const existing = await this.db.query.userSettings.findFirst({ where: eq(userSettings.id, "default") });
    if (existing) return existing;
    await this.db.insert(userSettings).values({ id: "default" }).onConflictDoNothing();
    const created = await this.db.query.userSettings.findFirst({ where: eq(userSettings.id, "default") });
    if (!created) throw new Error("Settings insert returned no record");
    return created;
  }

  async updateSettings(patch: SettingsPatch) {
    await this.db
      .insert(userSettings)
      .values({ id: "default", ...patch })
      .onConflictDoUpdate({ target: userSettings.id, set: { ...patch, updatedAt: new Date() } });
    return this.getSettings();
  }

  async listNotificationPreferences() {
    return this.db.select().from(notificationPreferences).orderBy(asc(notificationPreferences.type));
  }

  async upsertNotificationPreference(input: NotificationPreferenceInput) {
    const [saved] = await this.db
      .insert(notificationPreferences)
      .values(input)
      .onConflictDoUpdate({
        target: notificationPreferences.type,
        set: { ...input, updatedAt: new Date() },
      })
      .returning();
    if (!saved) throw new Error("Notification preference upsert returned no record");
    return saved;
  }

  async checkReady() {
    await this.db.execute(sql`select 1 as ready`);
    return true;
  }

  private async getMealWith(db: Pick<HealthDatabase, "query">, id: string) {
    const meal = await db.query.meals.findFirst({ where: eq(meals.id, id) });
    if (!meal) return null;
    const items = await db.query.mealItems.findMany({ where: eq(mealItems.mealId, id) });
    return { ...meal, items };
  }
}

function normalizeName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
