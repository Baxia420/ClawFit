import { eq } from "drizzle-orm";
import type { HealthDatabase } from "./client.js";
import { DEFAULT_HOUSEHOLD_ID, DEFAULT_PARTNER_USER_ID, DEFAULT_PRIMARY_USER_ID } from "./repository.js";
import { households, users } from "./schema.js";

export interface DisplayNameUpdateResult {
  primaryUser: { id: string; current: string; target: string; updated: boolean };
  partnerUser: { id: string; current: string; target: string; updated: boolean };
  household: { id: string; current: string; target: string; updated: boolean };
  dryRun: boolean;
}

export async function runDisplayNameUpdates(
  db: HealthDatabase,
  options: { dryRun: boolean },
): Promise<DisplayNameUpdateResult> {
  const primary = await db.query.users.findFirst({ where: eq(users.id, DEFAULT_PRIMARY_USER_ID) });
  const partner = await db.query.users.findFirst({ where: eq(users.id, DEFAULT_PARTNER_USER_ID) });
  const household = await db.query.households.findFirst({ where: eq(households.id, DEFAULT_HOUSEHOLD_ID) });

  if (!primary) throw new Error(`Primary user ${DEFAULT_PRIMARY_USER_ID} not found in database`);
  if (!partner) throw new Error(`Partner user ${DEFAULT_PARTNER_USER_ID} not found in database`);
  if (!household) throw new Error(`Default household ${DEFAULT_HOUSEHOLD_ID} not found in database`);

  const TARGET_PRIMARY_NAME = "Mahin";
  const TARGET_PARTNER_NAME = "Cici";
  const TARGET_HOUSEHOLD_NAME = "Mahin & Cici";

  const primaryNeedsUpdate = primary.displayName !== TARGET_PRIMARY_NAME;
  const partnerNeedsUpdate = partner.displayName !== TARGET_PARTNER_NAME;
  const householdNeedsUpdate = household.name !== TARGET_HOUSEHOLD_NAME;

  if (!options.dryRun) {
    if (primaryNeedsUpdate) {
      await db
        .update(users)
        .set({ displayName: TARGET_PRIMARY_NAME, updatedAt: new Date() })
        .where(eq(users.id, DEFAULT_PRIMARY_USER_ID));
    }
    if (partnerNeedsUpdate) {
      await db
        .update(users)
        .set({ displayName: TARGET_PARTNER_NAME, updatedAt: new Date() })
        .where(eq(users.id, DEFAULT_PARTNER_USER_ID));
    }
    if (householdNeedsUpdate) {
      await db
        .update(households)
        .set({ name: TARGET_HOUSEHOLD_NAME, updatedAt: new Date() })
        .where(eq(households.id, DEFAULT_HOUSEHOLD_ID));
    }
  }

  return {
    primaryUser: {
      id: DEFAULT_PRIMARY_USER_ID,
      current: primary.displayName,
      target: TARGET_PRIMARY_NAME,
      updated: primaryNeedsUpdate && !options.dryRun,
    },
    partnerUser: {
      id: DEFAULT_PARTNER_USER_ID,
      current: partner.displayName,
      target: TARGET_PARTNER_NAME,
      updated: partnerNeedsUpdate && !options.dryRun,
    },
    household: {
      id: DEFAULT_HOUSEHOLD_ID,
      current: household.name,
      target: TARGET_HOUSEHOLD_NAME,
      updated: householdNeedsUpdate && !options.dryRun,
    },
    dryRun: options.dryRun,
  };
}
