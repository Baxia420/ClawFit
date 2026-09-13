import { parseArgs } from "node:util";
import {
  createDatabase,
  runDisplayNameUpdates,
  type DisplayNameUpdateResult,
} from "../packages/db/src/index.js";
import { loadClawFitEnv } from "./load-env.js";

loadClawFitEnv();

export { runDisplayNameUpdates, type DisplayNameUpdateResult };

const isDirectRun = process.argv[1] && (process.argv[1].endsWith("update-display-names.ts") || process.argv[1].endsWith("update-display-names.js"));

if (isDirectRun) {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "database-url": { type: "string" },
    },
    allowPositionals: false,
  });

  const databaseUrl = values["database-url"] ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required to update display names.");
    process.exit(1);
  }

  const dryRun = values.apply ? false : true;
  const database = createDatabase(databaseUrl);

  try {
    console.log(`[DISPLAY_NAMES] Mode: ${dryRun ? "DRY RUN (no changes will be applied)" : "APPLY (updating database)"}`);
    const result = await runDisplayNameUpdates(database.db, { dryRun });

    console.log("\n--- Primary User ---");
    console.log(`ID:      ${result.primaryUser.id}`);
    console.log(`Current: "${result.primaryUser.current}"`);
    console.log(`Target:  "${result.primaryUser.target}"`);
    console.log(`Status:  ${result.primaryUser.updated ? "UPDATED" : result.dryRun ? "PENDING (dry-run)" : "ALREADY UP TO DATE"}`);

    console.log("\n--- Partner User ---");
    console.log(`ID:      ${result.partnerUser.id}`);
    console.log(`Current: "${result.partnerUser.current}"`);
    console.log(`Target:  "${result.partnerUser.target}"`);
    console.log(`Status:  ${result.partnerUser.updated ? "UPDATED" : result.dryRun ? "PENDING (dry-run)" : "ALREADY UP TO DATE"}`);

    console.log("\n--- Household ---");
    console.log(`ID:      ${result.household.id}`);
    console.log(`Current: "${result.household.current}"`);
    console.log(`Target:  "${result.household.target}"`);
    console.log(`Status:  ${result.household.updated ? "UPDATED" : result.dryRun ? "PENDING (dry-run)" : "ALREADY UP TO DATE"}`);

    if (dryRun) {
      console.log("\nTo apply these updates to the database, run with --apply:");
      console.log("  pnpm tsx scripts/update-display-names.ts --apply");
    } else {
      console.log("\n[SUCCESS] Display names have been updated successfully.");
    }
  } catch (error) {
    console.error("[DISPLAY_NAMES_ERROR]", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
