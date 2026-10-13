import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = "private-cli-test-token-at-least-24-chars";
const server = createServer((req, res) => {
  const authorized = req.url === "/ready" && req.headers.authorization === `Bearer ${token}`;
  res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify(authorized ? { status: "ready", estimator: "configured", database: "ok", schema: "ok" } : { error: "private error must never be logged" }));
});
let directory: string;
let url: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "clawfit-ready-cli-"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fake readiness service missing");
  url = `http://127.0.0.1:${address.port}`;
  await writeFile(path.join(directory, ".env"), `HEALTH_API_URL=${url}\nHEALTH_API_OPENCLAW_TOKEN=${token}\n`, { mode: 0o600 });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

const commands = [
  { name: "direct Node import", command: process.execPath, args: ["--import", "tsx", "scripts/health-readiness-diagnose.ts"] },
  { name: "tsx executable", command: process.execPath, args: ["node_modules/tsx/dist/cli.mjs", "scripts/health-readiness-diagnose.ts"] },
  { name: "pnpm script", command: "pnpm", args: ["openclaw:diagnose-api"] },
];
it.skipIf(process.platform === "win32").each(commands)("checks the same protected environment through $name without exposing values", async ({ command, args }) => {
  const { stdout } = await promisify(execFile)(command, args, { cwd: root, timeout: 30_000,
    env: { ...process.env, OPENCLAW_ENV_FILE: "", OPENCLAW_STATE_DIR: directory, HEALTH_API_URL: undefined, HEALTH_API_OPENCLAW_TOKEN: undefined },
  });
  const lines = stdout.split("\n").filter(line => line.startsWith("[clawfit-preflight] ")).map(line => JSON.parse(line.slice("[clawfit-preflight] ".length)));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ reason: "readiness_context", protectedEnvironment: { readable: true, HEALTH_API_URL: { present: true, matchesEffective: true }, HEALTH_API_OPENCLAW_TOKEN: { present: true, matchesEffective: true } } });
  expect(lines[1]).toMatchObject({ reason: "ready", httpStatus: 200, databaseOk: true, schemaOk: true });
  expect(stdout).not.toContain(token);
  expect(stdout).not.toContain(url);
  expect(stdout).not.toContain(directory);
});

it("identifies an inherited token override without revealing either token or weakening auth", async () => {
  let stdout = "";
  try {
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/health-readiness-diagnose.ts"], { cwd: root,
      env: { ...process.env, OPENCLAW_ENV_FILE: "", OPENCLAW_STATE_DIR: directory, HEALTH_API_URL: url, HEALTH_API_OPENCLAW_TOKEN: "different-private-token-at-least-24-chars" },
    });
    throw new Error("Expected a denied readiness request");
  } catch (error) {
    const result = error as { code?: number; stdout?: string };
    expect(result.code).toBe(1);
    stdout = result.stdout ?? "";
  }
  const context = JSON.parse(stdout.split("\n").find(line => line.includes('"reason":"readiness_context"'))!.slice("[clawfit-preflight] ".length));
  expect(context.inherited.HEALTH_API_OPENCLAW_TOKEN).toMatchObject({ present: true, matchesEffective: true });
  expect(context.protectedEnvironment.HEALTH_API_OPENCLAW_TOKEN).toMatchObject({ present: true, matchesEffective: false });
  expect(stdout).toContain('"reason":"http_unauthorized"');
  expect(stdout).not.toMatch(/different-private-token|private-cli-test-token|private error/);
});
