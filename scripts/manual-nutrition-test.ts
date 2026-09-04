import { loadClawFitEnv } from "./load-env.js";

loadClawFitEnv();

const apiUrl = process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.HEALTH_API_WEB_TOKEN ?? process.env.HEALTH_API_OPENCLAW_TOKEN;
if (!token) throw new Error("HEALTH_API_WEB_TOKEN or HEALTH_API_OPENCLAW_TOKEN is required");

const args = process.argv.slice(2);
const verifyEstimatorOnly = args.includes("--verify-estimator");
const promptArgs = args.filter((a) => a !== "--verify-estimator");

// Step 1: Query public readiness probe to inspect API readiness and estimator configuration status
console.log(`Checking API readiness probe at ${apiUrl}/ready...`);
const readyRes = await fetch(new URL("/ready", apiUrl));
if (!readyRes.ok) {
  console.error(`API readiness check failed with HTTP ${readyRes.status}. The API is not ready.`);
  process.exit(1);
}

const readyBody = (await readyRes.json().catch(() => ({}))) as {
  status?: string;
  database?: string;
  schema?: string;
  estimator?: string;
};
console.log("Readiness probe response:", JSON.stringify(readyBody, null, 2));

if (readyBody.estimator !== "configured") {
  const msg = "Nutrition estimator is NOT configured on the API (missing GEMINI_API_KEY or NUTRITION_MODEL_PRIMARY).";
  if (verifyEstimatorOnly) {
    console.error(`[SMOKE_FAILURE] ${msg}`);
    process.exit(1);
  } else {
    console.warn(`[WARNING] ${msg}`);
  }
} else {
  console.log("Nutrition estimator is verified as configured on the API.");
}

if (verifyEstimatorOnly && promptArgs.length === 0) {
  console.log("Estimator configuration smoke check passed.");
  process.exit(0);
}

// Step 2: Test live nutrition estimation endpoint
const text = promptArgs.join(" ") || "nasi kandar with fried chicken and mixed curry";
const headers: Record<string, string> = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

if (token === process.env.HEALTH_API_OPENCLAW_TOKEN) {
  headers["x-clawfit-conversation-id"] = process.env.CLAWFIT_CONVERSATION_ID ?? "smoke-nutrition-check";
  headers["x-clawfit-sender-id"] = process.env.CLAWFIT_PRIMARY_PHONE ?? "+15555550100";
  headers["x-clawfit-sender-provider"] = "whatsapp";
}

console.log(`Querying /v1/nutrition/estimate with text: "${text}"...`);
const response = await fetch(new URL("/v1/nutrition/estimate", apiUrl), {
  method: "POST",
  headers,
  body: JSON.stringify({ text }),
});

const result = await response.json();
console.log("Estimate response:", JSON.stringify(result, null, 2));
if (!response.ok) process.exit(1);
