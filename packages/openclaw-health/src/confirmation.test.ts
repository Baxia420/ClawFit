import { describe, expect, it } from "vitest";
import { isFallbackNotice, isMealLogConfirmation, sanitizeUserFacingError } from "./confirmation.js";

describe("meal log confirmation", () => {
  it.each(["log it", "Log it", "save it", "track this", "yes", "Okay!", "make it 500 and log it", "sure, log it", "please do", "confirm"])("accepts %s", (prompt) => {
    expect(isMealLogConfirmation(prompt)).toBe(true);
  });

  it.each(["I ate 3 eggs and toast", "estimate this meal", "what have I eaten today?", "", null, undefined])("rejects %s", (prompt) => {
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

  it("preserves standard user-facing messages", () => {
    const normal = "Logged 3 eggs and 2 slices of toast (350 kcal).";
    expect(sanitizeUserFacingError(normal)).toBe(normal);
  });
});
