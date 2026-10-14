// Ephemeral local API for browser acceptance. Never reads DATABASE_URL or production credentials.
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "../../packages/db/node_modules/drizzle-orm/pglite/index.js";
import { HealthRepository, DEFAULT_PRIMARY_USER_ID } from "../../packages/db/dist/repository.js";
import * as schema from "../../packages/db/dist/schema.js";
import type { HealthDatabase } from "../../packages/db/dist/client.js";
import { createApp } from "../../apps/api/src/create-app.js";
const pg = new PGlite();
for (const file of (await readdir(new URL("../../packages/db/drizzle/",import.meta.url))).filter(f=>f.endsWith(".sql")).sort()) {
  await pg.exec((await readFile(new URL(`../../packages/db/drizzle/${file}`,import.meta.url),"utf8")).replaceAll("--> statement-breakpoint",""));
}
const repository = new HealthRepository(drizzle(pg,{schema}) as unknown as HealthDatabase);
await repository.saveRoutine(DEFAULT_PRIMARY_USER_ID,{name:"Browser test plan",archived:false,exercises:[{name:"Original exercise",muscleGroup:"chest",sets:4,reps:10,restSeconds:120}],idempotencyKey:"browser-test-routine"});
const app=createApp({repository,assertionSecret:process.env.WEB_ASSERTION_SIGNING_SECRET!,webToken:"local-browser-test-machine-token",openclawToken:"local-browser-test-claw-token",logger:false});
await app.listen({host:"127.0.0.1",port:4009});
console.log("TEST_API_READY");
const close=async()=>{await app.close();await pg.close();process.exit(0);};
process.on("SIGTERM",()=>void close());
