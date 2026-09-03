import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDatabase(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10, prepare: false });
  return { db: drizzle(sql, { schema }), close: () => sql.end() };
}

export async function createEmbeddedDatabase(dataDir?: string) {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  try {
    await pg.query("SELECT 1 FROM user_settings LIMIT 1;");
  } catch {
    const migrationsDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));
    const migrationFiles = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
    for (const migrationName of migrationFiles) {
      const migration = await readFile(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
      await pg.exec(migration.replaceAll("--> statement-breakpoint", ""));
    }
  }
  const db = drizzlePglite(pg, { schema }) as unknown as HealthDatabase;
  return { db, close: () => pg.close() };
}

export type HealthDatabase = ReturnType<typeof createDatabase>["db"];

