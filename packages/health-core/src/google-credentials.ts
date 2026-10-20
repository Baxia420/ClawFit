import { z } from "zod";

// Each slot must belong to a different operator-verified Google project.
// Slot names are stable, non-secret diagnostic labels; keys never enter logs.
export const GOOGLE_KEY_ENV_NAMES = ["GEMINI_API_KEY", ...Array.from({ length: 8 }, (_, i) => `GEMINI_API_KEY_${i + 1}`)];
export type GoogleCredential = { id: string; envName: string; apiKey: string };
const keySchema = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);

export function readGoogleCredentials(env: Record<string, unknown>): GoogleCredential[] {
  if (Object.keys(env).some(name => /^GEMINI_API_KEY_\d+$/.test(name) && !GOOGLE_KEY_ENV_NAMES.includes(name) && env[name])) {
    throw new Error("Supported Google backup slots are GEMINI_API_KEY_1 through GEMINI_API_KEY_8.");
  }
  const credentials: GoogleCredential[] = [];
  const seen = new Set<string>();
  for (const [index, envName] of GOOGLE_KEY_ENV_NAMES.entries()) {
    const value = env[envName];
    if (value === undefined || value === "" || (typeof value === "string" && !value.trim())) continue;
    const parsed = keySchema.safeParse(env[envName]);
    if (!parsed.success) throw new Error(`Invalid protected credential in ${envName}; values are hidden.`);
    if (seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    credentials.push({ id: index === 0 ? "primary" : `backup-${index}`, envName, apiKey: parsed.data });
  }
  if (credentials.length && credentials[0]!.envName !== "GEMINI_API_KEY") throw new Error("GEMINI_API_KEY is required before adding backup credentials.");
  return credentials;
}
