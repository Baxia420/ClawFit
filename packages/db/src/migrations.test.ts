import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("pending meal scope migration", () => {
  it("backfills existing drafts before making scope_key required", async () => {
    const pg = new PGlite();
    try {
      for (const name of ["0000_fuzzy_doorman.sql", "0001_cuddly_pending_meals.sql", "0002_mobile_product_foundation.sql"]) {
        const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
        await pg.exec(sql.replaceAll("--> statement-breakpoint", ""));
      }
      await pg.exec(`
        INSERT INTO pending_meal_estimates (
          label, calories_best, calories_low, calories_high, protein_g, carbs_g, fat_g,
          confidence, source, occurred_at, idempotency_key, expires_at
        ) VALUES (
          'Legacy draft', 400, 350, 450, 30, 40, 12,
          'medium', 'text', '2026-08-19T00:00:00Z', 'legacy-pending-001', '2026-08-19T02:00:00Z'
        );
      `);

      const migration = await readFile(new URL("../drizzle/0003_scope_pending_meals.sql", import.meta.url), "utf8");
      await pg.exec(migration.replaceAll("--> statement-breakpoint", ""));

      const result = await pg.query<{ scope_key: string }>("SELECT scope_key FROM pending_meal_estimates");
      expect(result.rows).toEqual([{ scope_key: "legacy:unscoped" }]);
    } finally {
      await pg.close();
    }
  });
});

describe("two-user identity migration (0004)", () => {
  it("backfills legacy data to primary user and bootstraps partner safely", async () => {
    const pg = new PGlite();
    try {
      for (const name of [
        "0000_fuzzy_doorman.sql",
        "0001_cuddly_pending_meals.sql",
        "0002_mobile_product_foundation.sql",
        "0003_scope_pending_meals.sql",
      ]) {
        const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
        await pg.exec(sql.replaceAll("--> statement-breakpoint", ""));
      }

      // Seed legacy records across all pre-existing tables
      await pg.exec(`
        INSERT INTO meals (
          id, label, calories_best, calories_low, calories_high, protein_g, carbs_g, fat_g,
          confidence, source, occurred_at, idempotency_key
        ) VALUES (
          '11111111-1111-4111-a111-111111111111', 'Legacy meal', 500, 450, 550, 30, 40, 20,
          'high', 'text', '2026-08-01T00:00:00Z', 'legacy-meal-001'
        );

        INSERT INTO meal_items (
          meal_id, name, portion_description
        ) VALUES (
          '11111111-1111-4111-a111-111111111111', 'Rice', '1 bowl'
        );

        INSERT INTO pending_meal_estimates (
          id, label, calories_best, calories_low, calories_high, protein_g, carbs_g, fat_g,
          confidence, source, occurred_at, scope_key, idempotency_key, expires_at
        ) VALUES (
          '22222222-2222-4222-a222-222222222222', 'Legacy pending', 600, 550, 650, 35, 50, 25,
          'medium', 'text', '2026-08-02T00:00:00Z', 'legacy:scope', 'legacy-pending-002', '2026-08-02T02:00:00Z'
        );

        INSERT INTO food_presets (
          id, name, normalized_name, label, calories_best, calories_low, calories_high, protein_g, carbs_g, fat_g,
          confidence
        ) VALUES (
          '33333333-3333-4333-a333-333333333333', 'Oatmeal', 'oatmeal', 'Oatmeal bowl', 300, 280, 320, 10, 50, 5,
          'high'
        );

        INSERT INTO workouts (
          id, name, status, started_at, idempotency_key
        ) VALUES (
          '44444444-4444-4444-a444-444444444444', 'Legacy workout', 'active', '2026-08-03T00:00:00Z', 'legacy-workout-001'
        );

        INSERT INTO exercises (
          id, workout_id, name, normalized_name, position
        ) VALUES (
          '55555555-5555-4555-a555-555555555555', '44444444-4444-4444-a444-444444444444', 'Bench Press', 'bench press', 0
        );

        INSERT INTO workout_sets (
          exercise_id, set_number, weight_kg, reps, occurred_at, idempotency_key
        ) VALUES (
          '55555555-5555-4555-a555-555555555555', 1, 80, 8, '2026-08-03T00:05:00Z', 'legacy-set-001'
        );

        INSERT INTO user_settings (
          id, calorie_target, protein_target_g, timezone, preferred_units
        ) VALUES (
          'default', 2300, 165, 'Asia/Kuala_Lumpur', 'metric'
        );

        INSERT INTO notification_preferences (
          type, enabled, timezone, days_of_week, delivery_channel
        ) VALUES (
          'evening_progress', true, 'Asia/Kuala_Lumpur', '{1,2,3,4,5,6,7}', 'whatsapp'
        );
      `);

      // Run 0004 migration
      const migration = await readFile(new URL("../drizzle/0004_two_user_identity.sql", import.meta.url), "utf8");
      await pg.exec(migration.replaceAll("--> statement-breakpoint", ""));

      // 1. Verify Users bootstrapped
      const usersResult = await pg.query<{ id: string; display_name: string; role: string }>("SELECT id, display_name, role FROM users ORDER BY id");
      expect(usersResult.rows).toHaveLength(2);
      expect(usersResult.rows).toEqual([
        { id: "00000000-0000-0000-0000-000000000002", display_name: "Primary User", role: "primary" },
        { id: "00000000-0000-0000-0000-000000000003", display_name: "Partner", role: "partner" },
      ]);

      // 2. Verify Household and members
      const householdResult = await pg.query<{ id: string; name: string }>("SELECT id, name FROM households");
      expect(householdResult.rows).toEqual([
        { id: "00000000-0000-0000-0000-000000000001", name: "Default Household" },
      ]);
      const membersResult = await pg.query<{ household_id: string; user_id: string; role: string }>(
        "SELECT household_id, user_id, role FROM household_members ORDER BY user_id",
      );
      expect(membersResult.rows).toEqual([
        { household_id: "00000000-0000-0000-0000-000000000001", user_id: "00000000-0000-0000-0000-000000000002", role: "owner" },
        { household_id: "00000000-0000-0000-0000-000000000001", user_id: "00000000-0000-0000-0000-000000000003", role: "member" },
      ]);

      // 3. Verify Legacy Meal ownership backfilled
      const mealResult = await pg.query<{ id: string; user_id: string }>("SELECT id, user_id FROM meals");
      expect(mealResult.rows).toEqual([
        { id: "11111111-1111-4111-a111-111111111111", user_id: "00000000-0000-0000-0000-000000000002" },
      ]);

      // 4. Verify Legacy Pending Meal ownership backfilled
      const pendingResult = await pg.query<{ id: string; user_id: string }>("SELECT id, user_id FROM pending_meal_estimates");
      expect(pendingResult.rows).toEqual([
        { id: "22222222-2222-4222-a222-222222222222", user_id: "00000000-0000-0000-0000-000000000002" },
      ]);

      // 5. Verify Legacy Preset ownership backfilled
      const presetResult = await pg.query<{ id: string; user_id: string }>("SELECT id, user_id FROM food_presets");
      expect(presetResult.rows).toEqual([
        { id: "33333333-3333-4333-a333-333333333333", user_id: "00000000-0000-0000-0000-000000000002" },
      ]);

      // 6. Verify Legacy Workout ownership backfilled
      const workoutResult = await pg.query<{ id: string; user_id: string }>("SELECT id, user_id FROM workouts");
      expect(workoutResult.rows).toEqual([
        { id: "44444444-4444-4444-a444-444444444444", user_id: "00000000-0000-0000-0000-000000000002" },
      ]);

      // 7. Verify User Settings schema updated and both rows exist
      const settingsResult = await pg.query<{ user_id: string; calorie_target: number }>(
        "SELECT user_id, calorie_target FROM user_settings ORDER BY user_id",
      );
      expect(settingsResult.rows).toEqual([
        { user_id: "00000000-0000-0000-0000-000000000002", calorie_target: 2300 },
        { user_id: "00000000-0000-0000-0000-000000000003", calorie_target: 2000 },
      ]);

      // 8. Verify Notification Preferences ownership backfilled
      const notificationResult = await pg.query<{ user_id: string; type: string }>("SELECT user_id, type FROM notification_preferences");
      expect(notificationResult.rows).toEqual([
        { user_id: "00000000-0000-0000-0000-000000000002", type: "evening_progress" },
      ]);
    } finally {
      await pg.close();
    }
  });
});
