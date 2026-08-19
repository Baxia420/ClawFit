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
