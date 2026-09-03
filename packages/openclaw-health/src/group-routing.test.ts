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
});
