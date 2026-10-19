import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildModelConfiguration, validateGatewaySearch, parseAllowlist, selectSmokeModels, type SmokeReport } from "./openclaw-configuration.js";
import { reconcileGatewayToken } from "./gateway-state.js";
import { probeModels } from "./model-probes.js";

const lite = "gemini-3.5-flash-lite";
const gemma = "gemma-4-26b-a4b";
const strong = "gemini-3.6-flash";
function report(): SmokeReport {
  return { checkedAt: new Date().toISOString(), results: {
    "Gemini 3.5 Flash-Lite": { status: "available", modelId: lite, toolCalling: "pass", imageInput: "pass" },
    "Gemma 4 26B A4B": { status: "available", modelId: gemma, toolCalling: "pass" },
    "Gemini 3.6 Flash": { status: "available", modelId: strong, imageInput: "pass" },
    "Gemini 3.7 Flash": { status: "failed", modelId: "gemini-3.7-flash" },
  }, selected: { defaultModel: lite, generalFallback: gemma, nutritionPrimary: strong } };
}

describe("Gateway model evidence and routing", () => {
  it("registers only selected verified models with Google-native transport at both levels", () => {
    const config = buildModelConfiguration(report());
    expect(config.fallbacks).toEqual([]);
    expect(config.provider.api).toBe("google-generative-ai");
    expect(config.provider.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(config.provider).not.toHaveProperty("apiKey");
    expect(config.provider.models.map(m => m.id)).toEqual([lite, strong]);
    expect(config.provider.models.every(m => m.api === config.provider.api && m.baseUrl === config.provider.baseUrl)).toBe(true);
    expect(buildModelConfiguration(report())).toEqual(config);
  });
  it("does not invent fallbacks, duplicate nutrition primary, or register failed models", () => {
    const evidence = report();
    delete evidence.results["Gemma 4 26B A4B"];
    evidence.selected = selectSmokeModels(evidence.results);
    evidence.selected.nutritionFallback = strong;
    const config = buildModelConfiguration(evidence);
    expect(config.fallbacks).toEqual([]);
    expect(config.nutrition).toEqual([strong]);
  });
  it("rejects stale evidence, unverified or Gemma primary and untested image routing", () => {
    const stale = report(); stale.checkedAt = "2020-01-01T00:00:00Z";
    expect(() => buildModelConfiguration(stale)).toThrow("stale");
    const bad = report(); bad.selected.defaultModel = "unknown";
    expect(() => buildModelConfiguration(bad)).toThrow("default");
    const unsupported = report(); unsupported.selected.defaultModel = gemma;
    expect(() => buildModelConfiguration(unsupported)).toThrow("low-cost");
    const image = report(); image.results["Gemini 3.6 Flash"]!.imageInput = "not-tested";
    expect(() => buildModelConfiguration(image)).toThrow("image-input");
  });
  it("resolves the generated models using the actual pinned OpenClaw resolver, with no network", async () => {
    const require = createRequire(new URL("../packages/openclaw-health/package.json", import.meta.url));
    const root = dirname(dirname(dirname(require.resolve("openclaw/plugin-sdk"))));
    expect(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version).toBe("2026.7.1-2");
    const directory = resolve(root, "dist");
    let resolverPath: string | undefined;
    for (const file of (await readdir(directory)).filter(f => /^model-.*\.js$/.test(f))) {
      if ((await readFile(resolve(directory, file), "utf8")).includes("function resolveModel(provider, modelId,")) { resolverPath = resolve(directory, file); break; }
    }
    expect(resolverPath).toBeDefined();
    const source = await readFile(resolverPath!, "utf8");
    const exportName = /resolveModel as (\w+)/.exec(source)![1]!;
    const runtime = await import(pathToFileURL(resolverPath!).href);
    const config = buildModelConfiguration(report());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in regression tests"));
    try {
      for (const model of config.provider.models) {
        const result = runtime[exportName]("google", model.id, directory, { models: { providers: { google: config.provider } } }, {
          authStorage: {}, modelRegistry: { find: () => undefined, getAll: () => [] },
        });
        expect(result.model?.api).toBe("google-generative-ai");
        expect(result.model?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  it("requires successful grounding evidence before selecting a web search model", () => {
    const evidence = report();
    expect(buildModelConfiguration(evidence).webSearchModel).toBeUndefined();
    evidence.selected.webSearch = lite;
    expect(() => buildModelConfiguration(evidence)).toThrow("grounding");
    evidence.results["Gemini 3.5 Flash-Lite"]!.webSearch = "pass";
    expect(buildModelConfiguration(evidence).webSearchModel).toBe(lite);
    expect(selectSmokeModels(evidence.results).webSearch).toBe(lite);
    evidence.selected.webSearch = strong;
    evidence.results["Gemini 3.6 Flash"]!.webSearch = "pass";
    expect(() => buildModelConfiguration(evidence)).toThrow("low-cost");
  });
  it("preflight rejects a silent search policy mismatch or implicit model default", () => {
    expect(validateGatewaySearch({ tools: { alsoAllow: [] } })).toEqual([]);
    const config = { tools: { alsoAllow: ["web_search"], web: { search: { enabled: true, provider: "gemini" } } }, plugins: { allow: ["google"], entries: { google: { config: { webSearch: { model: lite } } } } }, models: { providers: { google: { models: [{ id: lite }] } } } };
    expect(validateGatewaySearch(config)).toEqual(["web_search"]);
    expect(() => validateGatewaySearch({ ...config, tools: { ...config.tools, alsoAllow: [] } })).toThrow();
    expect(() => validateGatewaySearch({ ...config, plugins: {} })).toThrow();
    expect(() => validateGatewaySearch({ ...config, models: { providers: { google: { models: [] } } } })).toThrow();
  });
  it.each([true, false])("grounding smoke checks actual sources, with citations=%s", async citations => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes("models?")) return Response.json({ models: [{ name: `models/${lite}`, supportedGenerationMethods: ["generateContent"] }] });
      const body = JSON.parse(String(init?.body));
      const grounded = body.tools?.[0]?.googleSearch !== undefined;
      return Response.json({ candidates: [{ content: { parts: !grounded && body.tools ? [{ functionCall: { name: "record_number", args: { value: 7 } } }] : [{ text: "OK" }] }, ...(grounded && citations ? { groundingMetadata: { groundingChunks: [{ web: { uri: "https://nodejs.org/en/about/previous-releases" } }] } } : {}) }] });
    });
    const evidence = await probeModels("fake-key", request, { webSearch: true });
    expect(evidence.selected.webSearch).toBe(citations ? lite : undefined);
    expect(evidence.results["Gemini 3.5 Flash-Lite"]?.webSearch).toBe(citations ? "pass" : "fail");
    expect(evidence.results["Gemini 3.5 Flash-Lite"]?.webSearchReason).toBe(citations ? undefined : "missing_grounded_sources");
    expect(request).toHaveBeenCalledTimes(5);
  });
  it("retains a safe search rejection status without provider messages or credentials", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes("models?")) return Response.json({ models: [{ name: `models/${lite}`, supportedGenerationMethods: ["generateContent"] }] });
      const body = JSON.parse(String(init?.body));
      if (body.tools?.[0]?.googleSearch) return Response.json({ error: { message: "private key and prompt" } }, { status: 403 });
      return Response.json({ candidates: [{ content: { parts: body.tools ? [{ functionCall: { name: "record_number", args: { value: 7 } } }] : [{ text: "OK" }] } }] });
    });
    const evidence = await probeModels("private-key", request, { webSearch: true });
    expect(evidence.results["Gemini 3.5 Flash-Lite"]?.webSearchReason).toBe("HTTP 403");
    expect(JSON.stringify(evidence)).not.toContain("private");
  });
  it("checks paginated catalog, tools and image input using injected responses", async () => {
    const request = vi.fn<typeof fetch>();
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("pageToken=second")) return Response.json({ models: [{ name: `models/${strong}`, supportedGenerationMethods: ["generateContent"] }] });
      if (String(url).includes("models?")) return Response.json({ models: [{ name: `models/${lite}`, supportedGenerationMethods: ["generateContent"] }], nextPageToken: "second" });
      const body = JSON.parse(String(init?.body));
      return Response.json({ candidates: [{ content: { parts: body.tools ? [{ functionCall: { name: "record_number", args: { value: 7 } } }] : [{ text: "OK" }] } }] });
    });
    const result = await probeModels("fake-test-key", request);
    expect(result.selected.defaultModel).toBe(lite);
    expect(result.selected.nutritionPrimary).toBe(strong);
    expect(result.results["Gemini 3.8 Flash"]?.status).toBe("unavailable");
    expect(request).toHaveBeenCalledTimes(8);
  });
});

describe("Gateway credentials and allowlists", () => {
  it("preserves the existing configured token and reconciles a competing env token", () => {
    const configured = "original-token-at-least-24-characters";
    expect(reconcileGatewayToken({ gateway: { auth: { mode: "token", token: configured } } }, { OPENCLAW_GATEWAY_TOKEN: "second-token-at-least-24-characters" })).toBe(configured);
    expect(reconcileGatewayToken({ gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } } }, { OPENCLAW_GATEWAY_TOKEN: configured })).toBe(configured);
  });
  it("fails closed for unresolved refs and non-token auth instead of replacing secrets", () => {
    expect(() => reconcileGatewayToken({ gateway: { auth: { mode: "password" } } }, {})).toThrow("not token");
    expect(() => reconcileGatewayToken({ gateway: { auth: { token: { source: "file", id: "secret" } } } }, {})).toThrow("external secret");
    expect(() => reconcileGatewayToken({ gateway: { auth: { token: "${NONEXISTENT_TEST_TOKEN}" } } }, {}, {})).toThrow("cannot be resolved");
  });
  it("validates restricted sender and group formats and removes duplicates", () => {
    expect(parseAllowlist("+60123456789,+60123456789", "senders")).toEqual(["+60123456789"]);
    expect(parseAllowlist('["120363123456@g.us"]', "groups")).toEqual(["120363123456@g.us"]);
    expect(() => parseAllowlist("*", "groups")).toThrow();
    expect(() => parseAllowlist("*", "senders")).toThrow();
  });
});
