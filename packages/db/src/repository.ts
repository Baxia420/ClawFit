import { and, asc, desc, eq, gt, gte, ilike, isNull, lt, sql } from "drizzle-orm";
import {
  estimatedOneRepMax,
  normalizeWhatsAppIdentifier,
  sumNutrition,
  workoutVolume,
  type CreateUserInput,
  type FoodPresetPatch,
  type LinkExternalIdentityInput,
  type MealInput,
  type MealPatch,
  type NotificationPreferenceInput,
  type PendingMealInput,
  type PendingMealPatch,
  type ResolveUserInput,
  type SettingsPatch,
  type WorkoutSetInput,
  type WorkoutSetPatch,
} from "@clawfit/health-core";
import type { HealthDatabase } from "./client.js";
import {
  exercises,
  externalIdentities,
  foodPresets,
  householdMembers,
  mealItems,
  meals,
  notificationPreferences,
  pendingMealEstimates,
  userSettings,
  users,
  workouts,
  workoutSets,
} from "./schema.js";

export const DEFAULT_HOUSEHOLD_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_PRIMARY_USER_ID = "00000000-0000-0000-0000-000000000002";
export const DEFAULT_PARTNER_USER_ID = "00000000-0000-0000-0000-000000000003";

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class ConflictError extends Error {
  override name = "ConflictError";
}

export type HydratedMeal = typeof meals.$inferSelect & { items: (typeof mealItems.$inferSelect)[] };

export class HealthRepository {
  constructor(private readonly db: HealthDatabase) {}

  async createUser(input: CreateUserInput) {
    const [created] = await this.db
      .insert(users)
      .values({
        displayName: input.displayName,
        role: input.role ?? "primary",
        active: input.active ?? true,
      })
      .returning();
    if (!created) throw new Error("User insert returned no record");
    return created;
  }

  async getUser(id: string) {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!user) throw new NotFoundError("User not found");
    return user;
  }

  async listUsers() {
    return this.db.select().from(users).orderBy(asc(users.createdAt));
  }

  async getHouseholdMembers(householdId: string = DEFAULT_HOUSEHOLD_ID) {
    return this.db
      .select({ member: householdMembers, user: users })
      .from(householdMembers)
      .innerJoin(users, eq(householdMembers.userId, users.id))
      .where(eq(householdMembers.householdId, householdId))
      .orderBy(asc(householdMembers.createdAt));
  }

  async getPartnerUser(userId: string) {
    const membership = await this.db.query.householdMembers.findFirst({
      where: eq(householdMembers.userId, userId),
    });
    if (!membership) return null;
    const partnerMember = await this.db
      .select({ user: users })
      .from(householdMembers)
      .innerJoin(users, eq(householdMembers.userId, users.id))
      .where(and(eq(householdMembers.householdId, membership.householdId), sql`${householdMembers.userId} <> ${userId}`))
      .limit(1);
    return partnerMember[0]?.user ?? null;
  }

  async linkExternalIdentity(input: LinkExternalIdentityInput) {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, input.userId) });
    if (!user) throw new NotFoundError("User not found");

    const externalIdentifier = input.provider === "whatsapp"
      ? normalizeWhatsAppIdentifier(input.externalIdentifier)
      : input.externalIdentifier.trim();

    const existing = await this.db.query.externalIdentities.findFirst({
      where: and(eq(externalIdentities.provider, input.provider), eq(externalIdentities.externalIdentifier, externalIdentifier)),
    });
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new ConflictError(`External identifier '${externalIdentifier}' is already mapped to another user`);
      }
      return existing;
    }

    const [created] = await this.db
      .insert(externalIdentities)
      .values({
        userId: input.userId,
        provider: input.provider,
        externalIdentifier,
        metadata: input.metadata ?? {},
      })
      .returning();
    if (!created) throw new Error("Failed to insert external identity");
    return created;
  }

  async resolveUser(input: ResolveUserInput) {
    const candidateIdentifiers: string[] = [input.externalIdentifier.trim()];
    if (input.provider === "whatsapp") {
      const normalized = normalizeWhatsAppIdentifier(input.externalIdentifier);
      if (!candidateIdentifiers.includes(normalized)) {
        candidateIdentifiers.unshift(normalized);
      }
    }

    let identity: typeof externalIdentities.$inferSelect | undefined;
    for (const candidate of candidateIdentifiers) {
      identity = await this.db.query.externalIdentities.findFirst({
        where: and(eq(externalIdentities.provider, input.provider), eq(externalIdentities.externalIdentifier, candidate)),
      });
      if (identity) break;
    }

    if (!identity) {
      return { resolved: false as const, reason: "unknown_external_identity" as const };
    }
    const user = await this.db.query.users.findFirst({ where: eq(users.id, identity.userId) });
    if (!user || !user.active) {
      return { resolved: false as const, reason: "user_inactive_or_missing" as const };
    }
    return { resolved: true as const, user, externalIdentity: identity };
  }

  async createMeal(userId: string, input: MealInput): Promise<HydratedMeal> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.meals.findFirst({
        where: and(eq(meals.userId, userId), eq(meals.idempotencyKey, input.idempotencyKey)),
      });
      if (existing) return (await this.getMealWith(tx, userId, existing.id))!;
      const [created] = await tx
        .insert(meals)
        .values({
          userId,
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
      return (await this.getMealWith(tx, userId, created.id))!;
    });
  }

  async createPendingMeal(userId: string, input: PendingMealInput): Promise<typeof pendingMealEstimates.$inferSelect> {
    const existing = await this.db.query.pendingMealEstimates.findFirst({
      where: and(
        eq(pendingMealEstimates.userId, userId),
        eq(pendingMealEstimates.scopeKey, input.scopeKey),
        eq(pendingMealEstimates.idempotencyKey, input.idempotencyKey),
      ),
    });
    if (existing) return existing;
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? 7_200) * 1000);
    const [created] = await this.db
      .insert(pendingMealEstimates)
      .values({
        userId,
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
        scopeKey: input.scopeKey,
        idempotencyKey: input.idempotencyKey,
        confirmed: false,
        expiresAt,
      })
      .onConflictDoNothing({ target: [pendingMealEstimates.userId, pendingMealEstimates.scopeKey, pendingMealEstimates.idempotencyKey] })
      .returning();
    if (created) return created;
    const concurrent = await this.db.query.pendingMealEstimates.findFirst({
      where: and(
        eq(pendingMealEstimates.userId, userId),
        eq(pendingMealEstimates.scopeKey, input.scopeKey),
        eq(pendingMealEstimates.idempotencyKey, input.idempotencyKey),
      ),
    });
    if (!concurrent) throw new Error("Pending meal insert returned no record");
    return concurrent;
  }

  async getPendingMeal(userId: string, id: string, scopeKey: string): Promise<typeof pendingMealEstimates.$inferSelect> {
    const pending = await this.db.query.pendingMealEstimates.findFirst({
      where: and(eq(pendingMealEstimates.id, id), eq(pendingMealEstimates.scopeKey, scopeKey), eq(pendingMealEstimates.userId, userId)),
    });
    if (!pending) throw new NotFoundError("Pending meal estimate not found");
    return pending;
  }

  async getLatestPendingMeal(userId: string, scopeKey: string, now: Date = new Date()): Promise<typeof pendingMealEstimates.$inferSelect | null> {
    const pending = await this.db.query.pendingMealEstimates.findFirst({
      where: and(
        eq(pendingMealEstimates.userId, userId),
        eq(pendingMealEstimates.confirmed, false),
        eq(pendingMealEstimates.scopeKey, scopeKey),
        isNull(pendingMealEstimates.cancelledAt),
        gt(pendingMealEstimates.expiresAt, now),
      ),
      orderBy: desc(pendingMealEstimates.createdAt),
    });
    return pending ?? null;
  }

  async updatePendingMeal(userId: string, id: string, scopeKey: string, patch: PendingMealPatch): Promise<typeof pendingMealEstimates.$inferSelect> {
    const current = await this.getPendingMeal(userId, id, scopeKey);
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
      .where(and(eq(pendingMealEstimates.id, id), eq(pendingMealEstimates.scopeKey, scopeKey), eq(pendingMealEstimates.userId, userId)))
      .returning();
    if (!updated) throw new NotFoundError("Pending meal estimate not found");
    return updated;
  }

  async cancelPendingMeal(userId: string, id: string, scopeKey: string): Promise<typeof pendingMealEstimates.$inferSelect> {
    const current = await this.getPendingMeal(userId, id, scopeKey);
    if (current.confirmed) throw new ConflictError("A confirmed meal draft cannot be cancelled");
    if (current.cancelledAt) return current;
    const [cancelled] = await this.db
      .update(pendingMealEstimates)
      .set({ cancelledAt: new Date(), updatedAt: new Date() })
      .where(and(eq(pendingMealEstimates.id, id), eq(pendingMealEstimates.scopeKey, scopeKey), eq(pendingMealEstimates.userId, userId)))
      .returning();
    if (!cancelled) throw new NotFoundError("Pending meal estimate not found");
    return cancelled;
  }

  async confirmPendingMeal(
    userId: string,
    id: string,
    options: { scopeKey: string; occurredAt?: Date | undefined; idempotencyKey?: string | undefined },
    now: Date = new Date(),
  ): Promise<HydratedMeal> {
    return this.db.transaction(async (tx) => {
      const pending = await tx.query.pendingMealEstimates.findFirst({
        where: and(eq(pendingMealEstimates.id, id), eq(pendingMealEstimates.scopeKey, options.scopeKey), eq(pendingMealEstimates.userId, userId)),
      });
      if (!pending) throw new NotFoundError("Pending meal estimate not found");
      if (pending.cancelledAt) throw new ConflictError("A cancelled meal draft cannot be confirmed");
      if (pending.confirmed && pending.mealId) {
        const existingMeal = await this.getMealWith(tx, userId, pending.mealId);
        if (existingMeal) return existingMeal;
      }
      if (pending.expiresAt <= now) throw new ConflictError("An expired meal draft cannot be confirmed");
      const mealIdempotencyKey = `confirmed_${pending.id}`;
      const existingByUq = await tx.query.meals.findFirst({
        where: and(eq(meals.userId, userId), eq(meals.idempotencyKey, mealIdempotencyKey)),
      });
      if (existingByUq) {
        await tx
          .update(pendingMealEstimates)
          .set({ confirmed: true, confirmedAt: new Date(), mealId: existingByUq.id, updatedAt: new Date() })
          .where(and(eq(pendingMealEstimates.id, id), eq(pendingMealEstimates.scopeKey, options.scopeKey), eq(pendingMealEstimates.userId, userId)));
        return (await this.getMealWith(tx, userId, existingByUq.id))!;
      }

      const [created] = await tx
        .insert(meals)
        .values({
          userId,
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
        .returning();

      const persisted = created ?? (await tx.query.meals.findFirst({ where: and(eq(meals.userId, userId), eq(meals.idempotencyKey, mealIdempotencyKey)) }));
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
        .where(and(eq(pendingMealEstimates.id, id), eq(pendingMealEstimates.scopeKey, options.scopeKey), eq(pendingMealEstimates.userId, userId)));

      return (await this.getMealWith(tx, userId, persisted.id))!;
    });
  }

  async getMeal(userId: string, id: string): Promise<HydratedMeal> {
    const result = await this.getMealWith(this.db, userId, id);
    if (!result) throw new NotFoundError("Meal not found");
    return result;
  }

  async listRecentMeals(userId: string, limit: number = 20): Promise<HydratedMeal[]> {
    const rows = await this.db.select().from(meals).where(eq(meals.userId, userId)).orderBy(desc(meals.occurredAt)).limit(limit);
    const results = await Promise.all(rows.map((row) => this.getMealWith(this.db, userId, row.id)));
    return results.filter((m): m is HydratedMeal => m !== null);
  }

  async updateMeal(userId: string, id: string, patch: MealPatch): Promise<HydratedMeal> {
    const current = await this.db.query.meals.findFirst({
      where: and(eq(meals.id, id), eq(meals.userId, userId)),
    });
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
      .where(and(eq(meals.id, id), eq(meals.userId, userId)))
      .returning();
    if (!updated) throw new NotFoundError("Meal not found");
    return this.getMeal(userId, id);
  }

  async deleteMeal(userId: string, id: string): Promise<{ id: string }> {
    const [deleted] = await this.db
      .delete(meals)
      .where(and(eq(meals.id, id), eq(meals.userId, userId)))
      .returning({ id: meals.id });
    if (!deleted) throw new NotFoundError("Meal not found");
    return deleted;
  }

  async dailyNutrition(userId: string, start: Date, end: Date): Promise<{ date: string; totals: ReturnType<typeof sumNutrition>; meals: typeof meals.$inferSelect[] }> {
    const rows = await this.db
      .select()
      .from(meals)
      .where(and(eq(meals.userId, userId), gte(meals.occurredAt, start), lt(meals.occurredAt, end)))
      .orderBy(asc(meals.occurredAt));
    return { date: start.toISOString().slice(0, 10), totals: sumNutrition(rows), meals: rows };
  }

  async nutritionTrend(userId: string, start: Date, end: Date): Promise<{ day: Date; calories_best: number; calories_low: number; calories_high: number; protein_g: number }[]> {
    const day = sql<Date>`date_trunc('day', ${meals.occurredAt})`;
    return this.db
      .select({
        day: day.as("day"),
        calories_best: sql<number>`sum(${meals.caloriesBest})::float`.as("calories_best"),
        calories_low: sql<number>`sum(${meals.caloriesLow})::float`.as("calories_low"),
        calories_high: sql<number>`sum(${meals.caloriesHigh})::float`.as("calories_high"),
        protein_g: sql<number>`sum(${meals.proteinG})::float`.as("protein_g"),
      })
      .from(meals)
      .where(and(eq(meals.userId, userId), gte(meals.occurredAt, start), lt(meals.occurredAt, end)))
      .groupBy(day)
      .orderBy(day);
  }

  async savePreset(userId: string, name: string, estimate: MealInput): Promise<typeof foodPresets.$inferSelect> {
    const normalizedName = normalizeName(name);

    const [preset] = await this.db
      .insert(foodPresets)
      .values({
        userId,
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
        target: [foodPresets.userId, foodPresets.normalizedName],
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
    if (!preset) throw new Error("Food preset upsert returned no record");
    return preset;
  }

  async findPresets(userId: string, query: string): Promise<(typeof foodPresets.$inferSelect)[]> {
    return this.db
      .select()
      .from(foodPresets)
      .where(and(eq(foodPresets.userId, userId), ilike(foodPresets.normalizedName, `%${normalizeName(query)}%`)))
      .limit(10);
  }

  async updatePreset(userId: string, id: string, patch: FoodPresetPatch): Promise<typeof foodPresets.$inferSelect> {
    const existing = await this.db.query.foodPresets.findFirst({
      where: and(eq(foodPresets.id, id), eq(foodPresets.userId, userId)),
    });
    if (!existing) throw new NotFoundError("Food preset not found");

    const effectiveLow = patch.caloriesLow ?? existing.caloriesLow;
    const effectiveBest = patch.caloriesBest ?? existing.caloriesBest;
    const effectiveHigh = patch.caloriesHigh ?? existing.caloriesHigh;

    if (effectiveLow > effectiveBest || effectiveBest > effectiveHigh) {
      throw new ConflictError("Calorie ranges must satisfy low <= best <= high");
    }

    const [updated] = await this.db
      .update(foodPresets)
      .set({
        ...(patch.name !== undefined ? { name: patch.name, normalizedName: normalizeName(patch.name) } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.caloriesBest !== undefined ? { caloriesBest: patch.caloriesBest } : {}),
        ...(patch.caloriesLow !== undefined ? { caloriesLow: patch.caloriesLow } : {}),
        ...(patch.caloriesHigh !== undefined ? { caloriesHigh: patch.caloriesHigh } : {}),
        ...(patch.proteinG !== undefined ? { proteinG: patch.proteinG } : {}),
        ...(patch.carbsG !== undefined ? { carbsG: patch.carbsG } : {}),
        ...(patch.fatG !== undefined ? { fatG: patch.fatG } : {}),
        ...(patch.fiberG !== undefined ? { fiberG: patch.fiberG } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
        ...(patch.uncertaintyReasons !== undefined ? { uncertaintyReasons: patch.uncertaintyReasons } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(foodPresets.id, id), eq(foodPresets.userId, userId)))
      .returning();
    if (!updated) throw new NotFoundError("Food preset not found");
    return updated;
  }

  async deletePreset(userId: string, id: string): Promise<{ id: string }> {
    const [deleted] = await this.db
      .delete(foodPresets)
      .where(and(eq(foodPresets.id, id), eq(foodPresets.userId, userId)))
      .returning({ id: foodPresets.id });
    if (!deleted) throw new NotFoundError("Food preset not found");
    return deleted;
  }

  async startWorkout(userId: string, input: { name: string; startedAt?: Date | undefined; idempotencyKey: string }): Promise<HydratedWorkout> {
    const existing = await this.db.query.workouts.findFirst({
      where: and(eq(workouts.userId, userId), eq(workouts.idempotencyKey, input.idempotencyKey)),
    });
    if (existing) return this.getWorkout(userId, existing.id);
    const active = await this.getActiveWorkout(userId);
    if (active) throw new ConflictError(`Workout ${active.workout.id} is already active`);
    const [created] = await this.db
      .insert(workouts)
      .values({ userId, name: input.name, startedAt: input.startedAt ?? new Date(), idempotencyKey: input.idempotencyKey })
      .returning();
    if (!created) throw new Error("Workout insert returned no record");
    return this.getWorkout(userId, created.id);
  }

  async getActiveWorkout(userId: string): Promise<HydratedWorkout | null> {
    const active = await this.db.query.workouts.findFirst({
      where: and(eq(workouts.userId, userId), eq(workouts.status, "active")),
      orderBy: desc(workouts.startedAt),
    });
    return active ? this.getWorkout(userId, active.id) : null;
  }

  async addWorkoutSet(userId: string, workoutId: string, input: WorkoutSetInput): Promise<typeof workoutSets.$inferSelect> {
    return this.db.transaction(async (tx) => {
      const workout = await tx.query.workouts.findFirst({
        where: and(eq(workouts.id, workoutId), eq(workouts.userId, userId)),
      });
      if (!workout) throw new NotFoundError("Workout not found");
      if (workout.status !== "active") throw new ConflictError("Cannot add a set to a finished workout");

      const duplicate = await tx
        .select({ set: workoutSets })
        .from(workoutSets)
        .innerJoin(exercises, eq(workoutSets.exerciseId, exercises.id))
        .where(
          and(
            eq(exercises.workoutId, workoutId),
            eq(workoutSets.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (duplicate[0]) return duplicate[0].set;
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

  async updateWorkoutSet(userId: string, id: string, patch: WorkoutSetPatch): Promise<typeof workoutSets.$inferSelect & { estimatedOneRepMax: number | null }> {
    const existing = await this.db
      .select({ set: workoutSets, workout: workouts })
      .from(workoutSets)
      .innerJoin(exercises, eq(workoutSets.exerciseId, exercises.id))
      .innerJoin(workouts, eq(exercises.workoutId, workouts.id))
      .where(and(eq(workoutSets.id, id), eq(workouts.userId, userId)))
      .limit(1);
    if (!existing[0]) throw new NotFoundError("Workout set not found");

    const [updated] = await this.db.update(workoutSets).set({ ...patch, updatedAt: new Date() }).where(eq(workoutSets.id, id)).returning();
    if (!updated) throw new NotFoundError("Workout set not found");
    return { ...updated, estimatedOneRepMax: estimatedOneRepMax(updated.weightKg, updated.reps) };
  }

  async deleteWorkoutSet(userId: string, id: string): Promise<{ id: string }> {
    const existing = await this.db
      .select({ set: workoutSets, workout: workouts })
      .from(workoutSets)
      .innerJoin(exercises, eq(workoutSets.exerciseId, exercises.id))
      .innerJoin(workouts, eq(exercises.workoutId, workouts.id))
      .where(and(eq(workoutSets.id, id), eq(workouts.userId, userId)))
      .limit(1);
    if (!existing[0]) throw new NotFoundError("Workout set not found");

    const [deleted] = await this.db.delete(workoutSets).where(eq(workoutSets.id, id)).returning({ id: workoutSets.id, exerciseId: workoutSets.exerciseId });
    if (!deleted) throw new NotFoundError("Workout set not found");
    const remaining = await this.db.select().from(workoutSets).where(eq(workoutSets.exerciseId, deleted.exerciseId)).orderBy(asc(workoutSets.setNumber));
    for (const [index, set] of remaining.entries()) {
      if (set.setNumber !== index + 1) await this.db.update(workoutSets).set({ setNumber: index + 1 }).where(eq(workoutSets.id, set.id));
    }
    return { id: deleted.id };
  }

  async finishWorkout(userId: string, id: string, finishedAt: Date = new Date()): Promise<HydratedWorkout> {
    const [updated] = await this.db
      .update(workouts)
      .set({ status: "finished", finishedAt, updatedAt: new Date() })
      .where(and(eq(workouts.id, id), eq(workouts.userId, userId)))
      .returning();
    if (!updated) throw new NotFoundError("Workout not found");
    return this.getWorkout(userId, id);
  }

  async getWorkout(userId: string, id: string): Promise<HydratedWorkout> {
    const workout = await this.db.query.workouts.findFirst({
      where: and(eq(workouts.id, id), eq(workouts.userId, userId)),
    });
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

  async workoutHistory(userId: string, limit: number = 20): Promise<HydratedWorkout[]> {
    const rows = await this.db.select({ id: workouts.id }).from(workouts).where(eq(workouts.userId, userId)).orderBy(desc(workouts.startedAt)).limit(limit);
    return Promise.all(rows.map((row) => this.getWorkout(userId, row.id)));
  }

  async previousExercisePerformance(userId: string, name: string, before: Date = new Date()): Promise<{ workoutId: string; sets: (typeof workoutSets.$inferSelect & { estimatedOneRepMax: number | null })[] } | null> {
    const exercise = await this.db
      .select({ exerciseId: exercises.id, workoutId: workouts.id })
      .from(exercises)
      .innerJoin(workouts, eq(exercises.workoutId, workouts.id))
      .where(and(eq(workouts.userId, userId), eq(exercises.normalizedName, normalizeName(name)), lt(workouts.startedAt, before)))
      .orderBy(desc(workouts.startedAt))
      .limit(1);
    if (!exercise[0]) return null;
    const sets = await this.db.select().from(workoutSets).where(eq(workoutSets.exerciseId, exercise[0].exerciseId)).orderBy(asc(workoutSets.setNumber));
    return { workoutId: exercise[0].workoutId, sets: sets.map((set) => ({ ...set, estimatedOneRepMax: estimatedOneRepMax(set.weightKg, set.reps) })) };
  }

  async exerciseHistory(userId: string, name: string, limit: number = 100): Promise<(typeof workoutSets.$inferSelect & { workoutName: string; workoutId: string; estimatedOneRepMax: number | null })[]> {
    const rows = await this.db
      .select({ set: workoutSets, workout: workouts })
      .from(workoutSets)
      .innerJoin(exercises, eq(workoutSets.exerciseId, exercises.id))
      .innerJoin(workouts, eq(exercises.workoutId, workouts.id))
      .where(and(eq(workouts.userId, userId), eq(exercises.normalizedName, normalizeName(name))))
      .orderBy(desc(workoutSets.occurredAt))
      .limit(limit);
    return rows.map(({ set, workout }) => ({ ...set, workoutName: workout.name, workoutId: workout.id, estimatedOneRepMax: estimatedOneRepMax(set.weightKg, set.reps) }));
  }

  async getSettings(userId: string): Promise<typeof userSettings.$inferSelect> {
    const existing = await this.db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
    if (existing) return existing;
    await this.db.insert(userSettings).values({ userId }).onConflictDoNothing();
    const created = await this.db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
    if (!created) throw new Error("Settings insert returned no record");
    return created;
  }

  async updateSettings(userId: string, patch: SettingsPatch): Promise<typeof userSettings.$inferSelect> {
    await this.db
      .insert(userSettings)
      .values({ userId, ...patch })
      .onConflictDoUpdate({ target: userSettings.userId, set: { ...patch, updatedAt: new Date() } });
    return this.getSettings(userId);
  }

  async listNotificationPreferences(userId: string): Promise<(typeof notificationPreferences.$inferSelect)[]> {
    return this.db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).orderBy(asc(notificationPreferences.type));
  }

  async upsertNotificationPreference(userId: string, input: NotificationPreferenceInput): Promise<typeof notificationPreferences.$inferSelect> {
    const [saved] = await this.db
      .insert(notificationPreferences)
      .values({ userId, ...input })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.type],
        set: { ...input, updatedAt: new Date() },
      })
      .returning();
    if (!saved) throw new Error("Notification preference upsert returned no record");
    return saved;
  }

  async checkReady() {
    const result = await this.db.execute(sql`
      SELECT u.id
      FROM users u
      INNER JOIN households h ON h.id = ${DEFAULT_HOUSEHOLD_ID}
      LEFT JOIN meals m ON m.user_id = u.id
      LEFT JOIN workouts w ON w.user_id = u.id
      WHERE u.id = ${DEFAULT_PRIMARY_USER_ID}
      LIMIT 1
    `);
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
    if (rows.length === 0) {
      throw new Error("ClawFit database schema is not ready: required Stage 1 identity bootstrap is missing");
    }
    return true;
  }

  private async getMealWith(db: Pick<HealthDatabase, "query">, userId: string, id: string) {
    const meal = await db.query.meals.findFirst({
      where: and(eq(meals.id, id), eq(meals.userId, userId)),
    });
    if (!meal) return null;
    const items = await db.query.mealItems.findMany({ where: eq(mealItems.mealId, id) });
    return { ...meal, items };
  }
}

export type HydratedWorkout = {
  workout: typeof workouts.$inferSelect;
  exercises: (typeof exercises.$inferSelect & { sets: (typeof workoutSets.$inferSelect & { estimatedOneRepMax: number | null })[] })[];
  volumeKg: number;
  setCount: number;
};

function normalizeName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
