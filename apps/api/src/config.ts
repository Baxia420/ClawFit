import { z } from "zod";

export const configSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    HEALTH_API_WEB_TOKEN: z.string().min(24),
    HEALTH_API_OPENCLAW_TOKEN: z.string().min(24),
    CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS: z.string().default(""),
    GEMINI_API_KEY: z.string().min(1).optional(),
    NUTRITION_MODEL_PRIMARY: z.string().min(1).default("gemini-3.8-flash"),
    NUTRITION_MODEL_FALLBACK: z.string().min(1).default("gemini-3.7-flash"),
    APP_TIMEZONE: z.string().min(1).default("Asia/Kuala_Lumpur"),
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default("127.0.0.1"),
    CLAWFIT_PRIMARY_GOOGLE_EMAIL: z.string().email().optional(),
    CLAWFIT_PARTNER_GOOGLE_EMAIL: z.string().email().optional(),
    WEB_ASSERTION_SIGNING_SECRET: z.string().min(32).optional(),
    HEALTH_API_AUTH_SECRET: z.string().min(32).optional(),
    AUTH_SECRET: z.string().min(32).optional(),
  })
  .refine(
    (cfg) => cfg.HEALTH_API_WEB_TOKEN !== cfg.HEALTH_API_OPENCLAW_TOKEN,
    "HEALTH_API_WEB_TOKEN and HEALTH_API_OPENCLAW_TOKEN must be configured and different from each other",
  )
  .refine(
    (cfg) => {
      const assertionSecret = cfg.WEB_ASSERTION_SIGNING_SECRET ?? cfg.HEALTH_API_AUTH_SECRET;
      if (!assertionSecret) return true;
      return (
        assertionSecret !== cfg.HEALTH_API_WEB_TOKEN &&
        assertionSecret !== cfg.HEALTH_API_OPENCLAW_TOKEN
      );
    },
    "Assertion signing secret must not be reused as HEALTH_API_WEB_TOKEN or HEALTH_API_OPENCLAW_TOKEN",
  )
  .refine(
    (cfg) => {
      const assertionSecret = cfg.WEB_ASSERTION_SIGNING_SECRET ?? cfg.HEALTH_API_AUTH_SECRET;
      if (cfg.AUTH_SECRET && assertionSecret && cfg.AUTH_SECRET === assertionSecret) {
        return false;
      }
      if (cfg.AUTH_SECRET && cfg.AUTH_SECRET === cfg.HEALTH_API_WEB_TOKEN) {
        return false;
      }
      return true;
    },
    "AUTH_SECRET must not be reused as assertion signing secret or machine token",
  )
  .refine(
    (cfg) => {
      if (cfg.CLAWFIT_PRIMARY_GOOGLE_EMAIL && cfg.CLAWFIT_PARTNER_GOOGLE_EMAIL) {
        return (
          cfg.CLAWFIT_PRIMARY_GOOGLE_EMAIL.toLowerCase().trim() !==
          cfg.CLAWFIT_PARTNER_GOOGLE_EMAIL.toLowerCase().trim()
        );
      }
      return true;
    },
    "CLAWFIT_PRIMARY_GOOGLE_EMAIL and CLAWFIT_PARTNER_GOOGLE_EMAIL cannot be identical",
  );

export type ApiConfig = z.infer<typeof configSchema>;



