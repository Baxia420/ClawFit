import { createServer } from "node:http";
import { mkdtemp, writeFile, mkdir, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = "observer-private-token-at-least-24-chars";
let fixture: string;
let endpoint: string;
let status = 200;
let body = JSON.stringify({ status: "ready", estimator: "configured", database: "ok", schema: "ok" });
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  expect(req.url).toBe("/ready");
  expect(req.headers.authorization).toBe(`Bearer ${token}`);
  res.writeHead(status, { "content-type": "application/json", ...(status === 302 ? { location: "https://private-untrusted.example.test" } : {}) });
  res.end(body);
});
beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "clawfit-original-gate-"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server unavailable");
  endpoint = `http://127.0.0.1:${address.port}`;
  await mkdir(path.join(fixture, "scripts"));
  await mkdir(path.join(fixture, "openclaw"));
  await mkdir(path.join(fixture, "state"));
  await mkdir(path.join(fixture, "bin"));
  // Exact deployed gate, not the refactored helper or a synthetic readiness check.
  let original = await readFile(path.join(root, "scripts/fixtures/openclaw-preflight-5555336.ts.fixture"), "utf8");
  // Historical source is committed so shallow CI checkouts need no git/network fetch.
  expect(createHash("sha256").update(original).digest("hex")).toBe("f31fe0d6158b8dfcbc105983ae37a2367d70bb425db95c79a9c75c9703358cad");
  for (const module of ["load-env", "gateway-state", "openclaw-cli", "openclaw-configuration"]) original = original.replace(JSON.stringify(`./${module}.js`), JSON.stringify(pathToFileURL(path.join(root, "scripts", `${module}.ts`)).href));
  await writeFile(path.join(fixture, "scripts/openclaw-preflight.ts"), original);
  await writeFile(path.join(fixture, "scripts/dns-failure-preload.mjs"), `
import { resolve } from "node:path";
if (process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), "scripts/openclaw-preflight.ts")) {
  const original = globalThis.fetch;
  let failures = Number(process.env.CLAWFIT_TEST_DNS_FAILURES ?? 0);
  globalThis.fetch = async (...args) => {
    if (failures-- > 0) throw Object.assign(new TypeError("private fake DNS error"), { cause: { code: process.env.CLAWFIT_TEST_DNS_CODE ?? "EAI_AGAIN" } });
    return original(...args);
  };
}
`);
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "dir");
  const policy = JSON.parse(await readFile(path.join(root, "openclaw/policy.json"), "utf8")) as { healthTools: string[] };
  await writeFile(path.join(fixture, "openclaw/policy.json"), JSON.stringify(policy));
  await writeFile(path.join(fixture, "state/.env"), `HEALTH_API_URL=${endpoint}\nHEALTH_API_OPENCLAW_TOKEN=${token}\nOPENCLAW_GATEWAY_TOKEN=${token}\nCLAWFIT_WHATSAPP_ALLOW_FROM=+60123456789\n`);
  await writeFile(path.join(fixture, "state/openclaw.json"), JSON.stringify({
    models: { providers: { google: { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: [{ id: "fake-model", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }] } } },
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } }, model: { primary: "google/fake-model", fallbacks: [] } } },
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }, remote: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    tools: { profile: "minimal", alsoAllow: policy.healthTools, deny: ["group:runtime", "group:fs", "browser", "web_fetch"] },
    channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+60123456789"], groupAllowFrom: ["+60123456789"], groupPolicy: "disabled" } },
  }));
  // Only the preceding CLI subprocesses are fake; readiness uses real HTTP.
  await writeFile(path.join(fixture, "bin/openclaw"), `#!${process.execPath}\nif (process.argv.includes("--version")) console.log("2026.7.1-2");\n`, { mode: 0o700 });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(fixture, { recursive: true, force: true });
});

async function run(pnpm = false, overrides: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await promisify(execFile)(pnpm ? "pnpm" : process.execPath,
      pnpm ? ["openclaw:preflight", "--before-restart"] : ["--import", "tsx", "scripts/openclaw-preflight.ts", "--before-restart"], {
        cwd: pnpm ? root : fixture, timeout: 30_000, env: { ...process.env,
          PATH: `${path.join(fixture, "bin")}${path.delimiter}${process.env.PATH}`,
          NODE_OPTIONS: `--import=${pathToFileURL(path.join(fixture, "scripts/dns-failure-preload.mjs")).href} --import=${pathToFileURL(path.join(root, "scripts/readiness-observer.mjs")).href}`,
          OPENCLAW_STATE_DIR: path.join(fixture, "state"), OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_ENV_FILE: "",
          HEALTH_API_URL: undefined, HEALTH_API_OPENCLAW_TOKEN: undefined, OPENCLAW_GATEWAY_TOKEN: undefined,
          CLAWFIT_WHATSAPP_ALLOW_FROM: undefined, CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS: "",
          CLAWFIT_VERIFY_READINESS_DNS_RETRY: "0", CLAWFIT_TEST_DNS_FAILURES: "0", CLAWFIT_TEST_DNS_CODE: "EAI_AGAIN",
          ...overrides,
        },
      }));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
    stderr = (error as { stderr?: string }).stderr ?? "";
  }
  const output = `${stdout}\n${stderr}`;
  expect(output).not.toContain(token);
  expect(output).not.toContain(endpoint);
  expect(output).not.toContain("+60123456789");
  return output;
}

it.skipIf(process.platform === "win32").each([
  [200, JSON.stringify({ status: "ready", estimator: "configured" }), "original_readiness_contract", true],
  [401, "private server error", "original_readiness_response", false],
  [503, "private server error", "original_readiness_response", false],
  [302, "private server error", "original_readiness_transport_failure", false],
  [200, "private invalid JSON", "original_readiness_body_failure", false],
  [200, JSON.stringify({ status: "ready", estimator: "unconfigured" }), "original_readiness_contract", false],
])("observes the unchanged deployed gate with HTTP %s and retains its result", async (httpStatus, response, reason, accepted) => {
  status = httpStatus;
  body = response;
  requests = 0;
  const output = await run();
  expect(output).toContain('"reason":"original_preflight_observer_attached"');
  expect(output.match(/"reason":"original_preflight_observer_attached"/g)).toHaveLength(1);
  expect(output).toContain('"redirectPolicy":"error"');
  expect(output).toContain(`"reason":"${reason}"`);
  expect(output).toContain(`${accepted ? "PASS" : "FAIL"} Health API readiness and configured nutrition estimator`);
  expect(output).not.toContain("private");
  expect(requests).toBe(1);
});

it.skipIf(process.platform === "win32")("shows the exact DNS code in the unchanged gate, without retrying observation mode", async () => {
  requests = 0;
  const output = await run(false, { CLAWFIT_TEST_DNS_FAILURES: "1" });
  expect(output).toContain('"failure":"dns_failure","dnsCode":"EAI_AGAIN"');
  expect(output).toContain("FAIL Health API readiness and configured nutrition estimator");
  expect(output).not.toContain('"reason":"readiness_dns_retry"');
  expect(output).not.toContain("private fake DNS error");
  expect(requests).toBe(0);
});

it.skipIf(process.platform === "win32")("verifies temporary DNS recovery inside the exact deployed full preflight with its original request", async () => {
  status = 200;
  body = JSON.stringify({ status: "ready", estimator: "configured" });
  requests = 0;
  const output = await run(false, { CLAWFIT_TEST_DNS_FAILURES: "1", CLAWFIT_VERIFY_READINESS_DNS_RETRY: "1" });
  expect(output).toContain('"verifyDnsRetry":true');
  expect(output).toContain('"reason":"readiness_dns_retry","attempt":1,"dnsCode":"EAI_AGAIN"');
  expect(output).toContain('"redirectPolicy":"error"');
  expect(output).toContain("PASS Health API readiness and configured nutrition estimator");
  expect(requests).toBe(1);
});

it.skipIf(process.platform === "win32").each(["EAI_AGAIN", "ENOTFOUND"])("retains failure for unrecovered %s in verification mode", async code => {
  requests = 0;
  const output = await run(false, { CLAWFIT_TEST_DNS_FAILURES: "3", CLAWFIT_TEST_DNS_CODE: code, CLAWFIT_VERIFY_READINESS_DNS_RETRY: "1" });
  expect(output).toContain(`"failure":"dns_failure","dnsCode":"${code}"`);
  expect(output).toContain("FAIL Health API readiness and configured nutrition estimator");
  expect(output.match(/"reason":"readiness_dns_retry"/g)?.length ?? 0).toBe(code === "EAI_AGAIN" ? 2 : 0);
  expect(requests).toBe(0);
});

it.skipIf(process.platform === "win32")("attaches to the actual pnpm package script and its tsx child, but not OpenClaw subprocesses", async () => {
  status = 200;
  body = JSON.stringify({ status: "ready", estimator: "configured" });
  requests = 0;
  const output = await run(true);
  expect(output).toContain('"reason":"original_preflight_observer_attached"');
  expect(output.match(/"reason":"original_preflight_observer_attached"/g)).toHaveLength(1);
  expect(output).toContain('"contractAccepted":true');
  expect(output).toContain("PASS Pinned OpenClaw version");
  expect(output).toContain("PASS Health API readiness and configured nutrition estimator");
  expect(requests).toBe(1);
});

it.skipIf(process.platform === "win32")("does not nest verification retries when the current package script already contains the fix", async () => {
  requests = 0;
  const output = await run(true, { CLAWFIT_TEST_DNS_FAILURES: "3", CLAWFIT_VERIFY_READINESS_DNS_RETRY: "1" });
  expect(output).toContain('"dnsRetryAlreadyInstalled":true');
  const report = output.split("\n").filter(line => line.startsWith("[clawfit-preflight] "))
    .map(line => JSON.parse(line.slice("[clawfit-preflight] ".length))).find(value => value.reason === "dns_failure");
  expect(report).toMatchObject({ dnsCode: "EAI_AGAIN", attempts: 3 });
  expect(output).toContain("FAIL Health API readiness and configured nutrition estimator");
  expect(output).not.toContain('"reason":"readiness_dns_retry"');
  expect(requests).toBe(0);
});

it.skipIf(process.platform === "win32")("identifies validation failure before fetch without issuing a replacement request", async () => {
  requests = 0;
  const output = await run(false, { HEALTH_API_OPENCLAW_TOKEN: "short" });
  expect(output).toContain('"reason":"original_readiness_request_not_observed"');
  expect(output).toContain('"tokenValid":false');
  expect(output).toContain("FAIL Health API readiness and configured nutrition estimator");
  expect(output).not.toContain('"reason":"original_readiness_request"');
  expect(requests).toBe(0);
});

it.skipIf(process.platform === "win32").each(["--observe-preflight", "--verify-dns-retry"])("runs the archived observer %s against the current package script without changing checkout or configuration", async mode => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const sha = git("rev-parse", "HEAD");
  const tree = git("status", "--porcelain");
  const config = await readFile(path.join(fixture, "state/openclaw.json"), "utf8");
  const environment = await readFile(path.join(fixture, "state/.env"), "utf8");
  status = 200;
  body = JSON.stringify({ status: "ready", estimator: "configured" });
  requests = 0;
  let output = "";
  try {
    const result = await promisify(execFile)(process.execPath, ["scripts/run-readiness-diagnostics.mjs", sha, mode], { cwd: root, timeout: 45_000,
      env: { ...process.env, PATH: `${path.join(fixture, "bin")}${path.delimiter}${process.env.PATH}`, OPENCLAW_STATE_DIR: path.join(fixture, "state"),
        OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_ENV_FILE: "", HEALTH_API_URL: undefined, HEALTH_API_OPENCLAW_TOKEN: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined, CLAWFIT_WHATSAPP_ALLOW_FROM: undefined, CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS: "" },
    });
    output = result.stdout;
  } catch (error) { output = (error as { stdout?: string }).stdout ?? ""; }
  expect(output).toContain('"reason":"original_readiness_contract","contractAccepted":true');
  expect(output).toContain(`"verifyDnsRetry":${mode === "--verify-dns-retry"}`);
  expect(output).toContain("PASS Health API readiness and configured nutrition estimator");
  expect(output).not.toContain(token);
  expect(output).not.toContain(endpoint);
  expect(output).not.toContain(fixture);
  expect(requests).toBe(1);
  expect(git("rev-parse", "HEAD")).toBe(sha);
  expect(git("status", "--porcelain")).toBe(tree);
  expect(await readFile(path.join(fixture, "state/openclaw.json"), "utf8")).toBe(config);
  expect(await readFile(path.join(fixture, "state/.env"), "utf8")).toBe(environment);
});
