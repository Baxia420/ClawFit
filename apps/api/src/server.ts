import { fileURLToPath } from "node:url";
import { NutritionEstimator } from "@clawfit/health-core";
import { createDatabase, createEmbeddedDatabase, DEFAULT_PRIMARY_USER_ID, HealthRepository, type HealthDatabase } from "@clawfit/db";
import { createApp } from "./create-app.js";
import { configSchema } from "./config.js";
import { GeminiNutritionClient } from "./gemini-client.js";
import { seedDemoDataIfEmpty } from "./demo-seed.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = configSchema.parse(process.env);
let database: { db: HealthDatabase; close: () => Promise<unknown> | unknown };

try {
  database = createDatabase(config.DATABASE_URL);
  const testRepo = new HealthRepository(database.db);
  await testRepo.getSettings(DEFAULT_PRIMARY_USER_ID);
} catch (error) {
  console.warn("[CLAWFIT_DB] PostgreSQL connection not available. Initializing embedded PGlite for demo...", (error as Error).message);
  database = await createEmbeddedDatabase("./.clawfit-data");
  const repo = new HealthRepository(database.db);
  await seedDemoDataIfEmpty(repo);
}

const models = [config.NUTRITION_MODEL_PRIMARY, config.NUTRITION_MODEL_FALLBACK].filter((model): model is string => Boolean(model));
const estimator = config.GEMINI_API_KEY && models.length > 0 ? new NutritionEstimator(new GeminiNutritionClient(config.GEMINI_API_KEY), models) : undefined;
const app = createApp({ repository: new HealthRepository(database.db), apiToken: config.HEALTH_API_TOKEN, ...(estimator ? { estimator } : {}) });

const close = async () => {
  await app.close();
  await database.close();
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

await app.listen({ host: config.HOST, port: config.PORT });
console.log(`ClawFit Health API running on http://${config.HOST}:${config.PORT}`);
