import { and, asc, desc, eq, gte, ilike, lt, sql } from "drizzle-orm";
import { estimatedOneRepMax, sumNutrition, workoutVolume, type MealInput, type MealPatch, type WorkoutSetInput, type WorkoutSetPatch } from "@clawfit/health-core";
import type { HealthDatabase } from "./client.js";
import { exercises, foodPresets, mealItems, meals, workouts, workoutSets } from "./schema.js";

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
      return this.getMealWith(tx, created.id);
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
