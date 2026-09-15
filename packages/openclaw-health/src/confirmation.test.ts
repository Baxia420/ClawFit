import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmMealDraft, isFallbackNotice, isMealLogConfirmation, sanitizeUserFacingError } from "./confirmation.js";

describe("meal log confirmation", () => {
  it.each(["log it", "Log it", "save it", "track this", "yes", "Okay!", "make it 500 and log it", "sure, log it", "please do", "confirm", "log both", "log all"])("accepts %s", (prompt) => {
    expect(isMealLogConfirmation(prompt)).toBe(true);
  });

  it.each([
    "I ate 3 eggs and toast",
    "estimate this meal",
    "what have I eaten today?",
    "don't log this",
    "do not save it",
    "estimate it without logging it",
    "log it not yet",
    "what did I log?",
    "have I recorded this meal?",
    "",
    null,
    undefined,
  ])("rejects %s", (prompt) => {
    expect(isMealLogConfirmation(prompt as string)).toBe(false);
  });
});

describe("fallback notice detection", () => {
  it.each([
    "↪️ Model Fallback: google/gemini-3.5-flash-lite (selected google/gemma-4-26b-a4b-it; Google Generative AI API error 429...)",
    "Model Fallback: google/gemini-3.5-flash-lite",
    "↪️ Model Fallback cleared: google/gemini-3.5-flash-lite",
  ])("identifies fallback notice: %s", (text) => {
    expect(isFallbackNotice(text)).toBe(true);
  });

  it.each([
    "Here is your meal estimate for 3 eggs and toast: 350 kcal.",
    "Logged your Push workout: 3 sets completed.",
    "What have you eaten today?",
    "I selected gemini for my meal estimation.",
    "We selected google/gemini as our model preference.",
  ])("identifies normal message: %s", (text) => {
    expect(isFallbackNotice(text)).toBe(false);
  });
});

describe("error sanitization", () => {
  it("sanitizes raw Google API 429 errors", () => {
    const raw = "Google Generative AI API error (429): You exceeded your current quota [code=RESOURCE_EXHAUSTED]";
    expect(sanitizeUserFacingError(raw)).toBe("I couldn't complete that just now. Nothing was changed — try again in a moment.");
  });

  it("sanitizes generic assistant turn failures", () => {
    const raw = "[assistant turn failed before producing content]";
    expect(sanitizeUserFacingError(raw)).toBe("I couldn't complete that just now. Nothing was changed — try again in a moment.");
  });

  it("sanitizes raw network failures", () => {
    const raw = "HealthApiNetworkError: fetch failed (ECONNREFUSED 127.0.0.1:4000)";
    expect(sanitizeUserFacingError(raw)).toBe("I couldn't complete that just now. Nothing was changed — try again in a moment.");
  });

  it("preserves standard user-facing messages", () => {
    const normal = "Logged 3 eggs and 2 slices of toast (350 kcal).";
    expect(sanitizeUserFacingError(normal)).toBe(normal);
  });
});

describe("confirmMealDraft idempotent helper", () => {
  const config = { apiUrl: "http://127.0.0.1:4000" };
  const scopeKey = "openclaw:whatsapp:test-scope";
  const draftId = "draft-12345";

  beforeEach(() => {
    vi.stubEnv("HEALTH_API_OPENCLAW_TOKEN", "test-token-at-least-24-characters");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns status: 'confirmed' when pending meal is successfully confirmed", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes(`/v1/meals/pending/${draftId}/confirm`)) {
        return new Response(
          JSON.stringify({
            id: "meal-99999",
            label: "Chicken breast and broccoli",
            caloriesBest: 450,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    });

    const result = await confirmMealDraft(
      { id: draftId, scopeKey },
      { config, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("confirmed");
    expect(result.mealId).toBe("meal-99999");
    expect(result.name).toBe("Chicken breast and broccoli");
    expect(result.calories).toBe(450);
    expect(result.message).toContain("successfully logged");
  });

  it("returns status: 'already_confirmed' when confirm returns 404 but recent meals contain confirmed draft", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes(`/v1/meals/pending/${draftId}/confirm`)) {
        return new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: "Pending meal estimate not found" } }),
          { status: 404 },
        );
      }
      if (urlStr.includes("/v1/meals/recent")) {
        return new Response(
          JSON.stringify([
            {
              id: "meal-existing-001",
              label: "Chicken breast and broccoli",
              caloriesBest: 450,
              idempotencyKey: `confirmed_${draftId}`,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    });

    const result = await confirmMealDraft(
      { id: draftId, scopeKey },
      { config, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("already_confirmed");
    expect(result.mealId).toBe("meal-existing-001");
    expect(result.name).toBe("Chicken breast and broccoli");
    expect(result.calories).toBe(450);
    expect(result.message).toBe("This meal has already been logged.");
  });

  it("returns status: 'already_confirmed' when draft ID is already a confirmed meal ID", async () => {
    const canonicalMealId = "meal-canonical-777";
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/confirm")) {
        return new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: "Pending meal estimate not found" } }),
          { status: 404 },
        );
      }
      if (urlStr.includes("/v1/meals/recent")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (urlStr.includes(`/v1/meals/${canonicalMealId}`)) {
        return new Response(
          JSON.stringify({
            id: canonicalMealId,
            label: "Oatmeal with berries",
            caloriesBest: 320,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    });

    const result = await confirmMealDraft(
      { id: canonicalMealId, scopeKey },
      { config, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("already_confirmed");
    expect(result.mealId).toBe(canonicalMealId);
    expect(result.name).toBe("Oatmeal with berries");
    expect(result.calories).toBe(320);
    expect(result.message).toBe("This meal has already been logged.");
  });

  it("rethrows NOT_FOUND when draft is not found in pending, recent, or direct meals", async () => {
    const unknownDraftId = "nonexistent-draft-999";
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/meals/recent")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "Pending meal estimate not found" } }),
        { status: 404 },
      );
    });

    await expect(
      confirmMealDraft(
        { id: unknownDraftId, scopeKey },
        { config, fetchImpl },
      ),
    ).rejects.toThrow("NOT_FOUND: Pending meal estimate not found");
  });
});

