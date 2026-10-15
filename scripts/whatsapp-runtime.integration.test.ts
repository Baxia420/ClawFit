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

it("replays a three-photo collection through the real CLI compile-cache respawn", async () => {
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("fixtures/whatsapp-cli-replay.mjs", import.meta.url))], { cwd: root, timeout: 58_000, maxBuffer: 4 * 1024 * 1024 });
  const line = stdout.split("\n").find(line => line.startsWith("CLAWFIT_CLI_RESULT="));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line!.slice("CLAWFIT_CLI_RESULT=".length));
  expect(result).toMatchObject({ stockCacheSeeded: true, readyCount: 2, dispatcherPatched: true, requestCount: 1, exactBytes: true, dispatchCount: 1, modelCalls: 4, writeRequestCount: 0 });
  expect(result.replies).toHaveLength(1);
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
  { name: "a model NO_REPLY after API failure still delivers the safe error", flags: ["--compat", "--fail-first", "--silent-failure"], requests: 2, replies: 2 },
  { name: "native web search coexists with the health tool under the minimal policy", flags: ["--compat", "--collection", "--search-enabled"], requests: 1, replies: 1 },
  { name: "one trusted collection forwards both originals once despite duplicate tool calls", flags: ["--compat", "--collection"], requests: 1, replies: 1 },
  { name: "two nearby photos with one caption form one estimate", flags: ["--compat", "--album"], requests: 1, replies: 1 },
  { name: "three nearby photos with one caption form one estimate", flags: ["--compat", "--album", "--three"], requests: 1, replies: 1 },
  { name: "a failed three-photo estimate has one safe reply and no guessed nutrition", flags: ["--compat", "--album", "--three", "--fail-first"], requests: 1, replies: 1 },
  { name: "no-save collection blocks valid model attempts to create and confirm a meal", flags: ["--compat", "--album", "--three", "--attempt-writes"], requests: 1, replies: 1 },
  { name: "three separately captioned photos stay separate", flags: ["--compat", "--simultaneous", "--three"], requests: 3, replies: 3 },
  { name: "different senders' photos never join a collection", flags: ["--compat", "--album", "--mixed-sender"], requests: 2, replies: 2 },
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
  expect(result.modelCalls).toBe(requests * (flags.includes("--attempt-writes") ? 4 : 2));
  expect(result.writeRequestCount).toBe(0);
  for (const names of result.modelTools) {
    expect(names.includes("web_search")).toBe(flags.includes("--search-enabled"));
    expect(names).not.toEqual(expect.arrayContaining(["web_fetch"]));
  }
  if (flags.includes("--compat")) expect(result.result.every((dispatch: { observedReplyDelivery?: boolean }) => dispatch.observedReplyDelivery === true)).toBe(true);
  if (flags.includes("--attempt-writes")) expect(result.replies[0]).toMatchObject({ text: "Offline estimate: 300 kcal" });
  if (flags.includes("--fail-first")) {
    expect(result.replies[0]).toMatchObject({ isError: true });
    expect(result.replies[0].text).not.toMatch(/kcal|300|Private provider failure/);
    if (requests > 1) expect(result.replies[1]).toMatchObject({ text: "Offline estimate: 300 kcal", replyToId: "photo-b" });
  } else if (flags.includes("--compat") && requests > 1) {
    expect(result.replies.map((reply: { replyToId: string }) => reply.replyToId)).toEqual(requests === 3 ? ["photo-a", "photo-b", "photo-c"] : ["photo-a", "photo-b"]);
  }
});

// The fake model deliberately ignores every rejection and keeps calling tools.
// The host must stop it; a compliant fake final response cannot prove this.
it.each([
  { flags: ["--compat", "--collection", "--fail-first", "--retry-failure"], calls: 2, requests: 1 },
  { flags: ["--compat", "--collection", "--unbound-write"], calls: 1, requests: 0 },
  { flags: ["--compat", "--fail-first", "--retry-failure"], calls: 4, requests: 2 },
])("terminates an unrecoverable tool rejection: $flags", async ({ flags, calls, requests }) => {
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("fixtures/whatsapp-burst-replay.mjs", import.meta.url)), ...flags], { cwd: root, timeout: 55_000, maxBuffer: 2 * 1024 * 1024 });
  const line = stdout.split("\n").find(line => line.startsWith("CLAWFIT_BURST_RESULT="));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line!.slice("CLAWFIT_BURST_RESULT=".length));
  expect(result.modelCalls).toBe(calls);
  expect(result.requestCount).toBe(requests);
  expect(result.writeRequestCount).toBe(0);
  expect(result.replies).toHaveLength(Math.max(1, requests));
  if (requests === 2) expect(result.replies[1].text).toBe("Offline estimate: 300 kcal");
  expect(result.replies[0].text).not.toMatch(/kcal|300|Private provider failure/);
});
