import { z } from "zod";

export const configSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    HEALTH_API_WEB_TOKEN: z.string().min(24),
    HEALTH_API_OPENCLAW_TOKEN: z.string().min(24),
    CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS: z.string().default(""),
    GEMINI_API_KEY: z.string().min(1).optional(),
    NUTRITION_MODEL_PRIMARY: z.string().min(1).optional(),
    NUTRITION_MODEL_FALLBACK: z.string().min(1).optional(),
    APP_TIMEZONE: z.string().min(1).default("Asia/Kuala_Lumpur"),
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default("127.0.0.1"),
  })
  .refine(
    (cfg) => cfg.HEALTH_API_WEB_TOKEN !== cfg.HEALTH_API_OPENCLAW_TOKEN,
    "HEALTH_API_WEB_TOKEN and HEALTH_API_OPENCLAW_TOKEN must be configured and different from each other",
  );

export type ApiConfig = z.infer<typeof configSchema>;


