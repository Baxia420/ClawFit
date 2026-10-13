import { createServer } from "node:http";
import { mkdtemp, writeFile, mkdir, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
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
  let original = execFileSync("git", ["show", "55553367fb1519eac188fe06fca199e1d9cf51a7:scripts/openclaw-preflight.ts"], { cwd: root, encoding: "utf8" });
  for (const module of ["load-env", "gateway-state", "openclaw-cli", "openclaw-configuration"]) original = original.replace(JSON.stringify(`./${module}.js`), JSON.stringify(pathToFileURL(path.join(root, "scripts", `${module}.ts`)).href));
  await writeFile(path.join(fixture, "scripts/openclaw-preflight.ts"), original);
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "dir");
  const policy = JSON.parse(await readFile(path.join(root, "openclaw/policy.json"), "utf8")) as { healthTools: string[] };
  await writeFile(path.join(fixture, "openclaw/policy.json"), JSON.stringify(policy));
  await writeFile(path.join(fixture, "state/.env"), `HEALTH_API_URL=${endpoint}\nHEALTH_API_OPENCLAW_TOKEN=${token}\nOPENCLAW_GATEWAY_TOKEN=${token}\nCLAWFIT_WHATSAPP_ALLOW_FROM=+60123456789\n`);
  await writeFile(path.join(fixture, "state/openclaw.json"), JSON.stringify({
    models: { providers: { google: { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: [{ id: "fake-model", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }] } } },
    agents: { defaults: { model: { primary: "google/fake-model", fallbacks: [] } } },
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
          NODE_OPTIONS: `--import=${pathToFileURL(path.join(root, "scripts/readiness-observer.mjs")).href}`,
          OPENCLAW_STATE_DIR: path.join(fixture, "state"), OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_ENV_FILE: "",
          HEALTH_API_URL: undefined, HEALTH_API_OPENCLAW_TOKEN: undefined, OPENCLAW_GATEWAY_TOKEN: undefined,
          CLAWFIT_WHATSAPP_ALLOW_FROM: undefined, CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS: "",
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

it.skipIf(process.platform === "win32")("identifies validation failure before fetch without issuing a replacement request", async () => {
  requests = 0;
  const output = await run(false, { HEALTH_API_OPENCLAW_TOKEN: "short" });
  expect(output).toContain('"reason":"original_readiness_request_not_observed"');
  expect(output).toContain('"tokenValid":false');
  expect(output).toContain("FAIL Health API readiness and configured nutrition estimator");
  expect(output).not.toContain('"reason":"original_readiness_request"');
  expect(requests).toBe(0);
});

it.skipIf(process.platform === "win32")("runs the archived observer against the current package script without changing checkout or configuration", async () => {
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
    const result = await promisify(execFile)(process.execPath, ["scripts/run-readiness-diagnostics.mjs", sha, "--observe-preflight"], { cwd: root, timeout: 45_000,
      env: { ...process.env, PATH: `${path.join(fixture, "bin")}${path.delimiter}${process.env.PATH}`, OPENCLAW_STATE_DIR: path.join(fixture, "state"),
        OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_ENV_FILE: "", HEALTH_API_URL: undefined, HEALTH_API_OPENCLAW_TOKEN: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined, CLAWFIT_WHATSAPP_ALLOW_FROM: undefined, CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS: "" },
    });
    output = result.stdout;
  } catch (error) { output = (error as { stdout?: string }).stdout ?? ""; }
  expect(output).toContain('"reason":"original_readiness_contract","contractAccepted":true');
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
