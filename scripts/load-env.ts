import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gatewayPaths } from "./gateway-state.js";

/** Shell/explicit file > protected Gateway env > repository development env.
 * The protected file is loaded before repo defaults so local development values
 * cannot silently change the service's credentials in CLI checks.
 */
export function loadClawFitEnv(): void {
  const explicitEnv = process.env.OPENCLAW_ENV_FILE;
  if (explicitEnv && !existsSync(explicitEnv)) throw new Error("OPENCLAW_ENV_FILE does not exist.");
  if (explicitEnv && existsSync(explicitEnv)) {
    try {
      process.loadEnvFile(explicitEnv);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const openclawEnv = gatewayPaths().envPath;
  if (existsSync(openclawEnv)) {
    try {
      process.loadEnvFile(openclawEnv);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const repoEnv = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(repoEnv)) {
    try {
      process.loadEnvFile(repoEnv);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

}
