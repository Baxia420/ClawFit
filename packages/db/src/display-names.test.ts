import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { runDisplayNameUpdates } from "./display-names.js";
import { DEFAULT_HOUSEHOLD_ID, DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID } from "./repository.js";
import * as schema from "./schema.js";
import type { HealthDatabase } from "./client.js";

describe("update-display-names script", () => {
  it("executes dry-run and apply idempotently against disposable database", async () => {
    const pg = new PGlite();
    try {
      const migrationsDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));
      const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
      for (const migrationName of migrations) {
        const migration = await readFile(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
        await pg.exec(migration.replaceAll("--> statement-breakpoint", ""));
      }

      const db = drizzle(pg, { schema }) as unknown as HealthDatabase;

      // Initial state from 0004 seed
      const u1 = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, DEFAULT_PRIMARY_USER_ID) });
      const u2 = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, DEFAULT_PARTNER_USER_ID) });
      const h = await db.query.households.findFirst({ where: (hh, { eq }) => eq(hh.id, DEFAULT_HOUSEHOLD_ID) });

      expect(u1?.displayName).toBe("Primary User");
      expect(u2?.displayName).toBe("Partner");
      expect(h?.name).toBe("Default Household");

      // 1. Dry run should NOT mutate
      const dryResult = await runDisplayNameUpdates(db, { dryRun: true });
      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.primaryUser.updated).toBe(false);
      expect(dryResult.primaryUser.target).toBe("Mahin");
      expect(dryResult.partnerUser.target).toBe("Cici");
      expect(dryResult.household.target).toBe("Mahin & Cici");

      const afterDry = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, DEFAULT_PRIMARY_USER_ID) });
      expect(afterDry?.displayName).toBe("Primary User");

      // 2. Apply should mutate to Mahin, Cici, Mahin & Cici
      const applyResult = await runDisplayNameUpdates(db, { dryRun: false });
      expect(applyResult.dryRun).toBe(false);
      expect(applyResult.primaryUser.updated).toBe(true);
      expect(applyResult.partnerUser.updated).toBe(true);
      expect(applyResult.household.updated).toBe(true);

      const afterApplyU1 = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, DEFAULT_PRIMARY_USER_ID) });
      const afterApplyU2 = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, DEFAULT_PARTNER_USER_ID) });
      const afterApplyH = await db.query.households.findFirst({ where: (hh, { eq }) => eq(hh.id, DEFAULT_HOUSEHOLD_ID) });

      expect(afterApplyU1?.displayName).toBe("Mahin");
      expect(afterApplyU2?.displayName).toBe("Cici");
      expect(afterApplyH?.name).toBe("Mahin & Cici");

      // 3. Second apply should be idempotent (no-op)
      const secondApply = await runDisplayNameUpdates(db, { dryRun: false });
      expect(secondApply.primaryUser.updated).toBe(false);
      expect(secondApply.partnerUser.updated).toBe(false);
      expect(secondApply.household.updated).toBe(false);
      expect(secondApply.primaryUser.current).toBe("Mahin");
      expect(secondApply.partnerUser.current).toBe("Cici");
      expect(secondApply.household.current).toBe("Mahin & Cici");
    } finally {
      await pg.close();
    }
  });
});
