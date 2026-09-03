import { z } from "zod";

export const configSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    HEALTH_API_TOKEN: z.string().min(24).optional(),
    HEALTH_API_WEB_TOKEN: z.string().min(24).optional(),
    HEALTH_API_OPENCLAW_TOKEN: z.string().min(24).optional(),
    CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS: z.string().default(""),
    GEMINI_API_KEY: z.string().min(1).optional(),
    NUTRITION_MODEL_PRIMARY: z.string().min(1).optional(),
    NUTRITION_MODEL_FALLBACK: z.string().min(1).optional(),
    APP_TIMEZONE: z.string().min(1).default("Asia/Kuala_Lumpur"),
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default("127.0.0.1"),
  })
  .refine(
    (cfg) => Boolean(cfg.HEALTH_API_TOKEN || (cfg.HEALTH_API_WEB_TOKEN && cfg.HEALTH_API_OPENCLAW_TOKEN)),
    "Either HEALTH_API_TOKEN or both HEALTH_API_WEB_TOKEN and HEALTH_API_OPENCLAW_TOKEN must be configured",
  );

export type ApiConfig = z.infer<typeof configSchema>;


