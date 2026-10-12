import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

it("replays the pinned host loader, real inbound finalizer and tool wrapper across separate registrations", async () => {
  // Build the current plugin source before the real host loads its manifest
  // entry. This regression must never silently test an old dist/ artifact.
  const root = fileURLToPath(new URL("..", import.meta.url));
  await execute(process.execPath, [path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"), "-p", "packages/openclaw-health/tsconfig.json"], { cwd: root });
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("fixtures/whatsapp-runtime-replay.mjs", import.meta.url))], { cwd: root, maxBuffer: 1024 * 1024 });
  const line = stdout.split("\n").find(line => line.startsWith("CLAWFIT_REPLAY_RESULT="));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line!.slice("CLAWFIT_REPLAY_RESULT=".length));
  expect(result).toMatchObject({ runtimeVersion: "2026.7.1-2", storedInInboundCache: true, distinctRegistrations: true, factoryHasMedia: false, factoryHasRun: false, dispatchHasRun: false, requestCount: 1, exactBytes: true, blocked: true, directWrite: { error: "meal_write_blocked", retryable: false }, stale: { error: "unauthorized_media", retryable: false }, safeDiagnostics: true });
  expect(result.results).toEqual([{ estimate: { label: "Original photo estimate" } }, { estimate: { label: "Original photo estimate" } }]);
  expect(result.hooks).toEqual(expect.arrayContaining(["reply_dispatch", "before_prompt_build", "before_tool_call", "reply_payload_sending"]));
});
