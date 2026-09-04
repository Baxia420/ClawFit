import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads ClawFit environment variables with deterministic precedence:
 * 1. Explicit file path in process.env.OPENCLAW_ENV_FILE (if specified)
 * 2. Repository-root .env (for local development)
 * 3. Protected OpenClaw environment file (~/.openclaw/.env) (for production VPS)
 *
 * Note: process.loadEnvFile does not overwrite already-set environment variables.
 * Therefore, variables set in shell or local .env take precedence, while
 * ~/.openclaw/.env provides production secrets on the VPS without storing
 * any .env file inside the git repository.
 */
export function loadClawFitEnv(): void {
  const explicitEnv = process.env.OPENCLAW_ENV_FILE;
  if (explicitEnv && existsSync(explicitEnv)) {
    try {
      process.loadEnvFile(explicitEnv);
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

  const openclawEnv = resolve(homedir(), ".openclaw", ".env");
  if (existsSync(openclawEnv)) {
    try {
      process.loadEnvFile(openclawEnv);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
