import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalizeWhatsAppIdentifier } from "../packages/health-core/src/index.js";
import { createDatabase, DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID, HealthRepository } from "../packages/db/src/index.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to link external identities.");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    user: { type: "string" },
    phone: { type: "string" },
    lid: { type: "string" },
    "from-env": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const database = createDatabase(databaseUrl);
const repository = new HealthRepository(database.db);

try {
  await repository.checkReady();

  if (values["from-env"]) {
    await linkFromEnv(repository);
  } else if (values.user && values.phone) {
    const role = values.user.toLowerCase();
    if (role !== "primary" && role !== "partner") {
      throw new Error("Invalid --user option. Must be 'primary' or 'partner'.");
    }
    const userId = role === "primary" ? DEFAULT_PRIMARY_USER_ID : DEFAULT_PARTNER_USER_ID;
    await linkUserIdentities(repository, role, userId, values.phone, values.lid);
  } else {
    console.log(`
ClawFit Identity Link Tool
Usage:
  pnpm identity:link --user <primary|partner> --phone <e164-or-digits> [--lid <lid>]
  pnpm identity:link --from-env

Environment variables for --from-env:
  CLAWFIT_PRIMARY_WHATSAPP_PHONE (or CLAWFIT_PRIMARY_WHATSAPP)
  CLAWFIT_PRIMARY_WHATSAPP_LID
  CLAWFIT_PARTNER_WHATSAPP_PHONE (or CLAWFIT_PARTNER_WHATSAPP)
  CLAWFIT_PARTNER_WHATSAPP_LID
`);
  }
} catch (error) {
  console.error("[IDENTITY_LINK_ERROR]", (error as Error).message);
  process.exitCode = 1;
} finally {
  await database.close();
}

async function linkFromEnv(repo: HealthRepository) {
  const primaryPhone = process.env.CLAWFIT_PRIMARY_WHATSAPP_PHONE ?? process.env.CLAWFIT_PRIMARY_WHATSAPP;
  const primaryLid = process.env.CLAWFIT_PRIMARY_WHATSAPP_LID;
  const partnerPhone = process.env.CLAWFIT_PARTNER_WHATSAPP_PHONE ?? process.env.CLAWFIT_PARTNER_WHATSAPP;
  const partnerLid = process.env.CLAWFIT_PARTNER_WHATSAPP_LID;

  if (!primaryPhone && !partnerPhone) {
    console.warn("[IDENTITY] No CLAWFIT_PRIMARY_WHATSAPP or CLAWFIT_PARTNER_WHATSAPP found in environment.");
    return;
  }

  if (primaryPhone) {
    await linkUserIdentities(repo, "primary", DEFAULT_PRIMARY_USER_ID, primaryPhone, primaryLid);
  }
  if (partnerPhone) {
    await linkUserIdentities(repo, "partner", DEFAULT_PARTNER_USER_ID, partnerPhone, partnerLid);
  }
}

async function linkUserIdentities(repo: HealthRepository, role: string, userId: string, phone: string, lid?: string) {
  const normalizedPhone = normalizeWhatsAppIdentifier(phone);
  await repo.linkExternalIdentity({
    userId,
    provider: "whatsapp",
    externalIdentifier: normalizedPhone,
  });
  console.log(`[IDENTITY] Successfully linked WhatsApp phone ${maskIdentifier(normalizedPhone)} to ${role} user (${userId})`);

  if (lid) {
    const normalizedLid = normalizeWhatsAppIdentifier(lid);
    await repo.linkExternalIdentity({
      userId,
      provider: "whatsapp",
      externalIdentifier: normalizedLid,
    });
    console.log(`[IDENTITY] Successfully linked WhatsApp LID ${maskIdentifier(normalizedLid)} to ${role} user (${userId})`);
  }
}

function maskIdentifier(id: string): string {
  if (id.length <= 6) return "***";
  return `${id.slice(0, 3)}****${id.slice(-4)}`;
}
