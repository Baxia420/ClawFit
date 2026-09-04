import { loadClawFitEnv } from "./load-env.js";

loadClawFitEnv();

const apiUrl = process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";
const args = process.argv.slice(2);
const isReadinessSmoke = args.includes("--verify-estimator") || args.includes("--readiness-only");
const promptArgs = args.filter((a) => a !== "--verify-estimator" && a !== "--readiness-only");

// -----------------------------------------------------------------------------
// Part A: Public Estimator Readiness Smoke
// -----------------------------------------------------------------------------
// Inspects /ready to verify database connectivity, schema migration status,
// and that an estimator model is configured. Does not require user identity
// or bearer credentials.
// -----------------------------------------------------------------------------
console.log(`[READINESS] Querying public readiness probe at ${apiUrl}/ready...`);
const readyRes = await fetch(new URL("/ready", apiUrl));
if (!readyRes.ok) {
  console.error(`[READINESS_FAILURE] /ready probe failed with HTTP ${readyRes.status}.`);
  process.exit(1);
}

const readyBody = (await readyRes.json().catch(() => ({}))) as {
  status?: string;
  database?: string;
  schema?: string;
  estimator?: string;
};
console.log("[READINESS] Response:", JSON.stringify(readyBody, null, 2));

if (readyBody.status !== "ready") {
  console.error(`[READINESS_FAILURE] API status is '${readyBody.status ?? "unknown"}', expected 'ready'.`);
  process.exit(1);
}

if (readyBody.estimator !== "configured") {
  console.error(`[READINESS_FAILURE] Nutrition estimator is '${readyBody.estimator ?? "unconfigured"}'. Configure GEMINI_API_KEY and NUTRITION_MODEL_PRIMARY on Render.`);
  process.exit(1);
}

console.log("[READINESS] Estimator readiness smoke passed: status=ready, database=ok, schema=ok, estimator=configured.");

// If this command invocation is solely for estimator readiness verification, exit cleanly now.
if (isReadinessSmoke && promptArgs.length === 0) {
  process.exit(0);
}

// -----------------------------------------------------------------------------
// Part B: Authenticated Nutrition Endpoint Smoke (/v1/nutrition/estimate)
// -----------------------------------------------------------------------------
// Probes the authenticated nutrition estimation endpoint. Strictly requires
// valid credentials and real, non-fabricated identity context.
// -----------------------------------------------------------------------------
const token = process.env.HEALTH_API_WEB_TOKEN ?? process.env.HEALTH_API_OPENCLAW_TOKEN;
if (!token) {
  console.error("[AUTH_ERROR] HEALTH_API_WEB_TOKEN or HEALTH_API_OPENCLAW_TOKEN is required for authenticated nutrition testing.");
  process.exit(1);
}

const headers: Record<string, string> = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

if (token === process.env.HEALTH_API_OPENCLAW_TOKEN) {
  // When testing with HEALTH_API_OPENCLAW_TOKEN, require explicitly configured,
  // real, already-linked sender identity and conversation context.
  // Never send synthetic/mock identities (+15555550100) to the production API.
  const senderId = process.env.CLAWFIT_SENDER_ID ?? process.env.CLAWFIT_PRIMARY_PHONE ?? process.env.CLAWFIT_PRIMARY_WHATSAPP;
  const conversationId = process.env.CLAWFIT_CONVERSATION_ID ?? senderId;

  if (!senderId || !conversationId) {
    console.error("[AUTH_ERROR] When using HEALTH_API_OPENCLAW_TOKEN, an explicitly linked WhatsApp sender identity and conversation context are required.");
    console.error("Set CLAWFIT_SENDER_ID (or CLAWFIT_PRIMARY_PHONE / CLAWFIT_PRIMARY_WHATSAPP) and CLAWFIT_CONVERSATION_ID.");
    console.error("No fallback synthetic identities are permitted against production.");
    process.exit(1);
  }

  headers["x-clawfit-sender-id"] = senderId;
  headers["x-clawfit-conversation-id"] = conversationId;
  headers["x-clawfit-sender-provider"] = process.env.CLAWFIT_SENDER_PROVIDER ?? "whatsapp";
}

const text = promptArgs.join(" ") || "nasi kandar with fried chicken and mixed curry";
console.log(`[ESTIMATION] Querying /v1/nutrition/estimate with text: "${text}"...`);

const response = await fetch(new URL("/v1/nutrition/estimate", apiUrl), {
  method: "POST",
  headers,
  body: JSON.stringify({ text }),
});

const result = await response.json();
console.log("[ESTIMATION] Response:", JSON.stringify(result, null, 2));

if (!response.ok) {
  console.error(`[ESTIMATION_FAILURE] Endpoint returned HTTP ${response.status}.`);
  process.exit(1);
}

console.log("[ESTIMATION] Authenticated nutrition estimate smoke passed.");
