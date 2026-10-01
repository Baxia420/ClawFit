import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDatabase(databaseUrl: string) {
  // Release unused sockets well before Neon's five-minute scale-to-zero window.
  // postgres.js reconnects lazily when the next query needs a connection.
  const sql = postgres(databaseUrl, {
    max: 10,
    prepare: false,
    idle_timeout: 30,
    connection: { application_name: "clawfit" },
  });
  return { db: drizzle(sql, { schema }), close: () => sql.end() };
}

export type HealthDatabase = ReturnType<typeof createDatabase>["db"];
