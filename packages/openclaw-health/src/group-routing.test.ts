import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("OpenClaw group routing and multi-user isolation", () => {
  const approvedGroupId = "123456789-987654@g.us";
  const unapprovedGroupId = "999999999-111111@g.us";
  const userAPhone = "+60123456789";
  const userBPhone = "+60198765432";

  beforeEach(() => {
    vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "test-openclaw-token-at-least-24-chars");
    vi.stubEnv("CLAWFIT_WHATSAPP_ALLOWED_GROUP_IDS", approvedGroupId);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("blocks tools in unapproved WhatsApp groups before making an API call", async () => {
    const fetchMock = vi.fn();
    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };

    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const instance = findTool("log_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: unapprovedGroupId },
    });

    const result = await instance.execute("call-1", {
      label: "Eggs",
      items: [{ name: "Eggs", portionDescription: "2 eggs" }],
      calories: { best: 140, low: 130, high: 150 },
      macros: { proteinG: 12, carbsG: 1, fatG: 10, fiberG: 0 },
      confidence: "high",
      uncertaintyReasons: [],
      occurredAt: new Date().toISOString(),
      source: "text",
      rawUserText: "log 2 eggs",
      idempotencyKey: "meal-unapproved-group-1",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("This WhatsApp group is not authorized");
  });

  it("blocks tools for unknown senders before making an API call", async () => {
    const fetchMock = vi.fn();
    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };

    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const instance = findTool("log_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: undefined, // missing / unknown
      deliveryContext: { to: approvedGroupId },
    });

    const result = await instance.execute("call-2", {
      label: "Eggs",
      items: [{ name: "Eggs", portionDescription: "2 eggs" }],
      calories: { best: 140, low: 130, high: 150 },
      macros: { proteinG: 12, carbsG: 1, fatG: 10, fiberG: 0 },
      confidence: "high",
      uncertaintyReasons: [],
      occurredAt: new Date().toISOString(),
      source: "text",
      rawUserText: "log 2 eggs",
      idempotencyKey: "meal-no-sender-1",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("This WhatsApp account isn't linked to a ClawFit profile yet.");
  });

  it("blocks tools when WhatsApp conversation context is missing before making an API call", async () => {
    const fetchMock = vi.fn();
    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };

    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const instance = findTool("log_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: undefined, // missing conversation context
    });

    const result = await instance.execute("call-missing-conv", {
      label: "Eggs",
      items: [{ name: "Eggs", portionDescription: "2 eggs" }],
      calories: { best: 140, low: 130, high: 150 },
      macros: { proteinG: 12, carbsG: 1, fatG: 10, fiberG: 0 },
      confidence: "high",
      uncertaintyReasons: [],
      occurredAt: new Date().toISOString(),
      source: "text",
      rawUserText: "log 2 eggs",
      idempotencyKey: "meal-no-conv-1",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("Missing WhatsApp conversation context");
  });

  it("supports simultaneous meal drafts and confirmations for two users in the same approved group", async () => {
    const drafts = new Map<string, any>();
    const meals = new Map<string, any>();

    // Mock fetchImpl simulating the Health API backend with per-user isolation
    const mockFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const urlStr = url.toString();
      const headers = new Headers(init?.headers);
      const senderId = headers.get("x-clawfit-sender-id");
      const conversationId = headers.get("x-clawfit-conversation-id");
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      // Group check
      if (conversationId && conversationId.includes("@g.us") && conversationId !== approvedGroupId) {
        return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED_GROUP", message: "Group not authorized" } }), { status: 403 });
      }

      // Draft creation
      if (urlStr.includes("/v1/meals/pending") && init?.method === "POST" && !urlStr.includes("/confirm")) {
        const id = `draft-${senderId}-${drafts.size + 1}`;
        const record = { id, userId: senderId, scopeKey: body.scopeKey, label: body.label, confirmed: false };
        drafts.set(id, record);
        return new Response(JSON.stringify(record), { status: 201 });
      }

      // Draft confirmation
      if (urlStr.includes("/confirm") && init?.method === "POST") {
        const match = urlStr.match(/\/v1\/meals\/pending\/([^/]+)\/confirm/);
        const draftId = match?.[1] ?? "";
        const draft = drafts.get(draftId);

        // Security check: draft must exist, belong to caller, and match scope
        if (!draft || draft.userId !== senderId || draft.scopeKey !== body.scopeKey) {
          return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Pending meal estimate not found" } }), { status: 404 });
        }

        draft.confirmed = true;
        const mealId = `meal-${senderId}-${meals.size + 1}`;
        const meal = { id: mealId, userId: senderId, label: draft.label };
        meals.set(mealId, meal);
        return new Response(JSON.stringify(meal), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    // Mock global fetch for this test
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    // 1. User A in shared group: "I had chicken rice"
    const userACreateInstance = findTool("create_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
      sessionKey: "group-session-1",
    });

    const userARes = await userACreateInstance.execute("call-user-a-1", {
      label: "Chicken rice",
      items: [{ name: "Chicken rice", portionDescription: "1 plate" }],
      calories: { best: 600, low: 550, high: 650 },
      macros: { proteinG: 30, carbsG: 70, fatG: 20, fiberG: 2 },
      confidence: "medium",
      uncertaintyReasons: [],
      occurredAt: new Date().toISOString(),
      source: "text",
      rawUserText: "I had chicken rice",
      idempotencyKey: "draft-user-a-1",
    });

    const userADraftData = JSON.parse((userARes as any).content[0].text);
    expect(userADraftData.id).toBe(`draft-${userAPhone}-1`);

    // 2. User B in shared group: "I had salmon and potatoes"
    const userBCreateInstance = findTool("create_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userBPhone,
      deliveryContext: { to: approvedGroupId },
      sessionKey: "group-session-1",
    });

    const userBRes = await userBCreateInstance.execute("call-user-b-1", {
      label: "Salmon and potatoes",
      items: [{ name: "Salmon", portionDescription: "200g fillet" }],
      calories: { best: 500, low: 450, high: 550 },
      macros: { proteinG: 40, carbsG: 35, fatG: 18, fiberG: 4 },
      confidence: "high",
      uncertaintyReasons: [],
      occurredAt: new Date().toISOString(),
      source: "text",
      rawUserText: "I had salmon and potatoes",
      idempotencyKey: "draft-user-b-1",
    });

    const userBDraftData = JSON.parse((userBRes as any).content[0].text);
    expect(userBDraftData.id).toBe(`draft-${userBPhone}-2`);

    // 3. User B attempts to confirm User A's draft -> Rejected
    const userBConfirmInstance = findTool("confirm_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userBPhone,
      deliveryContext: { to: approvedGroupId },
      sessionKey: "group-session-1",
    });

    await expect(
      userBConfirmInstance.execute("call-cross-confirm", {
        id: userADraftData.id,
      }),
    ).rejects.toThrow("NOT_FOUND: Pending meal estimate not found");

    // 4. User A confirms User A's draft -> Success
    const userAConfirmInstance = findTool("confirm_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
      sessionKey: "group-session-1",
    });

    const userAConfirmRes = await userAConfirmInstance.execute("call-user-a-confirm", {
      id: userADraftData.id,
    });
    const userAMealData = JSON.parse((userAConfirmRes as any).content[0].text);
    expect(userAMealData.label).toBe("Chicken rice");
    expect(userAMealData.userId).toBe(userAPhone);

    // 5. User B confirms User B's draft -> Success
    const userBConfirmRes = await userBConfirmInstance.execute("call-user-b-confirm", {
      id: userBDraftData.id,
    });
    const userBMealData = JSON.parse((userBConfirmRes as any).content[0].text);
    expect(userBMealData.label).toBe("Salmon and potatoes");
    expect(userBMealData.userId).toBe(userBPhone);
  });

  it("ensures get_daily_nutrition never invokes the nutrition estimator", async () => {
    const mockFetch = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/nutrition/daily")) {
        return new Response(JSON.stringify({
          date: "2026-09-08",
          timezone: "Asia/Kuala_Lumpur",
          meals: [],
          totals: { calories: 1785, proteinG: 120, carbsG: 200, fatG: 50, fiberG: 25 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const tool = findTool("get_daily_nutrition", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-daily", {
      date: "2026-09-08",
      timezone: "Asia/Kuala_Lumpur",
    });

    const data = JSON.parse((res as any).content[0].text);
    expect(data.totals.calories).toBe(1785);

    // Verify estimator endpoint was NEVER called
    for (const call of mockFetch.mock.calls) {
      expect(call[0].toString()).not.toContain("/v1/nutrition/estimate");
    }
  });

  it("ensures confirm_pending_meal never invokes the nutrition estimator", async () => {
    const mockFetch = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/confirm")) {
        return new Response(JSON.stringify({
          id: "meal-uuid-1",
          label: "Confirmed Chicken",
          calories: { best: 450, low: 400, high: 500 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const tool = findTool("confirm_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-confirm", {
      id: "draft-uuid-1",
    });

    const data = JSON.parse((res as any).content[0].text);
    expect(data.status).toBe("confirmed");
    expect(data.confirmedMealId).toBe("meal-uuid-1");

    // Verify estimator endpoint was NEVER called
    for (const call of mockFetch.mock.calls) {
      expect(call[0].toString()).not.toContain("/v1/nutrition/estimate");
    }
  });

  it("resolves local media image attachment and forwards base64 buffer to /v1/nutrition/estimate", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const testImagePath = join(tmpdir(), `clawfit-test-${Date.now()}.jpg`);
    // Write valid JPEG header bytes
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    writeFileSync(testImagePath, jpegBuffer);

    let capturedRequestBody: any = null;
    const mockFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/nutrition/estimate")) {
        capturedRequestBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          model: "gemini-3.8-flash",
          fallbackUsed: false,
          calories: { best: 520, low: 480, high: 560 },
          label: "Protein bowl",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const mockApi: any = {
        registerTool: vi.fn(),
        on: vi.fn(),
        runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
      };
      plugin.register(mockApi);
      const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
      const findTool = (name: string, toolContext: any) => {
        for (const fn of registered) {
          const inst = typeof fn === "function" ? fn(toolContext) : fn;
          if (inst?.name === name) return inst;
        }
        throw new Error(`Tool ${name} not found`);
      };

      const tool = findTool("estimate_nutrition", {
        messageChannel: "whatsapp",
        requesterSenderId: userAPhone,
        deliveryContext: { to: approvedGroupId },
        authorizedMediaPaths: [testImagePath],
      });

      const res = await tool.execute("call-estimate-img", {
        text: "Healthy protein bowl with chicken and greens",
        imagePath: testImagePath,
      });

      const data = JSON.parse((res as any).content[0].text);
      expect(data.model).toBe("gemini-3.8-flash");
      expect(capturedRequestBody).toBeDefined();
      expect(capturedRequestBody.text).toBe("Healthy protein bowl with chicken and greens");
      expect(capturedRequestBody.image).toBeDefined();
      expect(capturedRequestBody.image.mimeType).toBe("image/jpeg");
      expect(capturedRequestBody.image.base64).toBe(jpegBuffer.toString("base64"));
    } finally {
      try {
        unlinkSync(testImagePath);
      } catch {
        // ignore
      }
    }
  });

  it("supports batch confirmation with count=2 when 2 drafts exist", async () => {
    const mockFetch = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/meals/pending?") || urlStr.endsWith("/v1/meals/pending")) {
        return new Response(JSON.stringify({
          pending: [
            { id: "draft-1", label: "Meal 1", calories: { best: 250 }, occurredAt: new Date().toISOString() },
            { id: "draft-2", label: "Meal 2", calories: { best: 45 }, occurredAt: new Date().toISOString() },
          ],
        }), { status: 200 });
      }
      if (urlStr.includes("/v1/meals/pending/draft-1/confirm")) {
        return new Response(JSON.stringify({ id: "meal-1", label: "Meal 1", calories: { best: 250 } }), { status: 200 });
      }
      if (urlStr.includes("/v1/meals/pending/draft-2/confirm")) {
        return new Response(JSON.stringify({ id: "meal-2", label: "Meal 2", calories: { best: 45 } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const tool = findTool("confirm_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-batch-2", { count: 2, idempotencyKey: "test-batch-key-12345" });
    const data = JSON.parse((res as any).content[0].text);

    expect(data.status).toBe("confirmed");
    expect(data.confirmedMeals).toHaveLength(2);
    expect(data.confirmedMeals[0].confirmedMealId).toBe("meal-1");
    expect(data.confirmedMeals[1].confirmedMealId).toBe("meal-2");
  });

  it("returns ambiguous_drafts error when count=2 and > 2 drafts exist in scope", async () => {
    const mockFetch = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/meals/pending?") || urlStr.endsWith("/v1/meals/pending")) {
        return new Response(JSON.stringify({
          pending: [
            { id: "draft-1", label: "Meal 1", calories: { best: 250 }, occurredAt: new Date().toISOString() },
            { id: "draft-2", label: "Meal 2", calories: { best: 45 }, occurredAt: new Date().toISOString() },
            { id: "draft-3", label: "Meal 3", calories: { best: 600 }, occurredAt: new Date().toISOString() },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const tool = findTool("confirm_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-ambiguous", { count: 2 });
    const data = JSON.parse((res as any).content[0].text);

    expect(data.error).toBe("ambiguous_drafts");
    expect(data.message).toContain("3 active unconfirmed meal drafts");
    expect(data.pendingDrafts).toHaveLength(3);
  });

  it("reports partial success when one draft confirmation fails and another succeeds", async () => {
    const mockFetch = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/meals/pending/draft-ok/confirm")) {
        return new Response(JSON.stringify({ id: "meal-ok", label: "Good meal", calories: { best: 300 } }), { status: 200 });
      }
      if (urlStr.includes("/v1/meals/pending/draft-fail/confirm")) {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Draft expired" } }), { status: 404 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const tool = findTool("confirm_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-partial", { ids: ["draft-ok", "draft-fail"] });
    const data = JSON.parse((res as any).content[0].text);

    expect(data.status).toBe("partial_success");
    expect(data.partialSuccess).toBe(true);
    expect(data.confirmedMeals).toHaveLength(1);
    expect(data.confirmedMeals[0].confirmedMealId).toBe("meal-ok");
    expect(data.failures).toHaveLength(1);
    expect(data.failures[0].pendingDraftId).toBe("draft-fail");
  });

  it("executes compound confirmation + daily total read with strict write-before-read ordering", async () => {
    const callOrder: string[] = [];
    const mockFetch = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/confirm")) {
        callOrder.push("write:confirm");
        return new Response(JSON.stringify({ id: "meal-compound-1", label: "Steak and rice", calories: { best: 750 } }), { status: 200 });
      }
      if (urlStr.includes("/v1/nutrition/daily")) {
        callOrder.push("read:daily");
        return new Response(JSON.stringify({
          date: "2026-09-08",
          totals: { caloriesBest: 1785, proteinG: 120, carbsG: 200, fatG: 50, fiberG: 25 },
          meals: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const tool = findTool("confirm_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-compound", {
      id: "draft-compound-1",
      date: "2026-09-08",
      timezone: "Asia/Kuala_Lumpur",
    });
    const data = JSON.parse((res as any).content[0].text);

    // Verify write occurred strictly before read
    expect(callOrder).toEqual(["write:confirm", "read:daily"]);
    expect(data.confirmedMealId).toBe("meal-compound-1");
    expect(data.status).toBe("confirmed");
    expect(data.dailyNutrition).toBeDefined();
    expect(data.dailyNutrition.totals.caloriesBest).toBe(1785);
    expect(data.summaryError).toBeUndefined();
  });

  it("isolates summary read failure from confirmed meal mutation so retries do not duplicate", async () => {
    const mockFetch = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/confirm")) {
        return new Response(JSON.stringify({ id: "meal-isolated-1", label: "Tofu salad", calories: { best: 320 } }), { status: 200 });
      }
      if (urlStr.includes("/v1/nutrition/daily")) {
        return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Database read timeout" } }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const tool = findTool("confirm_pending_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-summary-fail", {
      id: "draft-isolated-1",
      date: "2026-09-08",
      timezone: "Asia/Kuala_Lumpur",
    });
    const data = JSON.parse((res as any).content[0].text);

    // Mutation succeeded and confirmedMealId is intact
    expect(data.status).toBe("confirmed");
    expect(data.confirmedMealId).toBe("meal-isolated-1");
    // Summary error is recorded without failing the confirmation
    expect(data.summaryError).toBeDefined();
    expect(data.dailyNutrition).toBeUndefined();
  });

  it("executes update_meal with post-write daily nutrition read", async () => {
    const callOrder: string[] = [];
    const mockFetch = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/meals/meal-update-1")) {
        callOrder.push("write:patch");
        return new Response(JSON.stringify({ id: "meal-update-1", label: "Corrected steak", caloriesBest: 800 }), { status: 200 });
      }
      if (urlStr.includes("/v1/nutrition/daily")) {
        callOrder.push("read:daily");
        return new Response(JSON.stringify({
          date: "2026-09-08",
          totals: { caloriesBest: 1835 },
          meals: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    const tool = findTool("update_meal", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-update-summary", {
      id: "meal-update-1",
      patch: { label: "Corrected steak", caloriesBest: 800 },
      date: "2026-09-08",
      timezone: "Asia/Kuala_Lumpur",
    });
    const data = JSON.parse((res as any).content[0].text);

    expect(callOrder).toEqual(["write:patch", "read:daily"]);
    expect(data.id).toBe("meal-update-1");
    expect(data.caloriesBest).toBe(800);
    expect(data.dailyNutrition).toBeDefined();
    expect(data.dailyNutrition.totals.caloriesBest).toBe(1835);
  });

  it("produces structured error before inference when requested image is unauthorized", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const mockApi: any = {
      registerTool: vi.fn(),
      on: vi.fn(),
      runContext: { setRunContext: vi.fn(), getRunContext: vi.fn() },
    };
    plugin.register(mockApi);
    const registered = mockApi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const findTool = (name: string, toolContext: any) => {
      for (const fn of registered) {
        const inst = typeof fn === "function" ? fn(toolContext) : fn;
        if (inst?.name === name) return inst;
      }
      throw new Error(`Tool ${name} not found`);
    };

    // Sender A tries to access an unauthorized attachment path
    const tool = findTool("estimate_nutrition", {
      messageChannel: "whatsapp",
      requesterSenderId: userAPhone,
      deliveryContext: { to: approvedGroupId },
    });

    const res = await tool.execute("call-unauth-image", {
      text: "Look at this dish",
      imagePath: "C:\\secret\\forbidden.jpg",
    });
    const data = JSON.parse((res as any).content[0].text);

    expect(data.error).toBe("unauthorized_media");
    expect(data.message).toBeDefined();
    // Verify inference was NEVER invoked
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
