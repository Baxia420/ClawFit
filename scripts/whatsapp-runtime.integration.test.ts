import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL("..", import.meta.url));
beforeAll(async () => {
  // Build the current plugin source before the real host loads its manifest
  // entry. This regression must never silently test an old dist/ artifact.
  await execute(process.execPath, [path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"), "-p", "packages/openclaw-health/tsconfig.json"], { cwd: root });
});

it("replays the pinned host loader, real inbound finalizer and tool wrapper across separate registrations", async () => {
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("fixtures/whatsapp-runtime-replay.mjs", import.meta.url))], { cwd: root, maxBuffer: 1024 * 1024 });
  const line = stdout.split("\n").find(line => line.startsWith("CLAWFIT_REPLAY_RESULT="));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line!.slice("CLAWFIT_REPLAY_RESULT=".length));
  expect(result).toMatchObject({ runtimeVersion: "2026.7.1-2", storedInInboundCache: true, distinctRegistrations: true, factoryHasMedia: false, factoryHasRun: false, dispatchHasRun: false, requestCount: 1, exactBytes: true, blocked: true, directWrite: { error: "meal_write_blocked", retryable: false }, stale: { error: "unauthorized_media", retryable: false }, safeDiagnostics: true });
  expect(result.results).toEqual([{ estimate: { label: "Original photo estimate" } }, { estimate: { label: "Original photo estimate" } }]);
  expect(result.hooks).toEqual(expect.arrayContaining(["reply_dispatch", "before_prompt_build", "before_tool_call", "reply_payload_sending"]));
});

it.each([
  { name: "unmodified host suppresses one overlapping reply", flags: [], requests: 2, replies: 1 },
  { name: "serialized photo burst keeps both replies", flags: ["--compat"], requests: 2, replies: 2 },
  { name: "simultaneous arrivals bind distinct turns", flags: ["--compat", "--simultaneous"], requests: 2, replies: 2 },
  { name: "a failed estimate cannot hide the next photo or become guessed nutrition", flags: ["--compat", "--fail-first"], requests: 2, replies: 2 },
  { name: "one trusted collection forwards both originals once despite duplicate tool calls", flags: ["--compat", "--collection"], requests: 1, replies: 1 },
])("full pinned runtime: $name", async ({ flags, requests, replies }) => {
  // The real host generates run IDs, registers/replaces plugins, builds model
  // prompts, invokes tools and delivers replies. Only model/API transports are
  // fake. No hooks or tool contexts receive test-injected run IDs or paths.
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("fixtures/whatsapp-burst-replay.mjs", import.meta.url)), ...flags], { cwd: root, timeout: 55_000, maxBuffer: 2 * 1024 * 1024 });
  const line = stdout.split("\n").find(line => line.startsWith("CLAWFIT_BURST_RESULT="));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line!.slice("CLAWFIT_BURST_RESULT=".length));
  expect(result.requestCount).toBe(requests);
  expect(result.exactBytes).toBe(true);
  expect(result.dispatchHasRun).toBe(false);
  expect(result.dispatchCount).toBe(requests);
  expect(result.registryReplaced).toBe(true);
  expect(result.replies).toHaveLength(replies);
  expect(result.modelCalls).toBe(flags.includes("--collection") ? 2 : 4);
  if (flags.includes("--fail-first")) {
    expect(result.replies[0]).toMatchObject({ isError: true });
    expect(result.replies[0].text).not.toMatch(/kcal|300|Private provider failure/);
    expect(result.replies[1]).toMatchObject({ text: "Offline estimate: 300 kcal", replyToId: "photo-b" });
  } else if (flags.includes("--compat") && !flags.includes("--collection")) {
    expect(result.replies.map((reply: { replyToId: string }) => reply.replyToId)).toEqual(["photo-a", "photo-b"]);
  }
});
