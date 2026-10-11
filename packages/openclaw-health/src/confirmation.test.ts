import { describe, expect, it } from "vitest";
import { isFallbackNotice, isMealLogConfirmation, isNoSaveRequest, sanitizeUserFacingError, TEMPORARY_FAILURE } from "./confirmation.js";

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
  ])("identifies normal message: %s", (text) => {
    expect(isFallbackNotice(text)).toBe(false);
  });
});

describe("error sanitization", () => {
  it("sanitizes raw Google API 429 errors", () => {
    const raw = "Google Generative AI API error (429): You exceeded your current quota [code=RESOURCE_EXHAUSTED]";
    expect(sanitizeUserFacingError(raw)).toBe(TEMPORARY_FAILURE);
  });

  it("sanitizes generic assistant turn failures", () => {
    const raw = "[assistant turn failed before producing content]";
    expect(sanitizeUserFacingError(raw)).toBe(TEMPORARY_FAILURE);
  });

  it("sanitizes raw network failures", () => {
    const raw = "HealthApiNetworkError: fetch failed (ECONNREFUSED 127.0.0.1:4000)";
    expect(sanitizeUserFacingError(raw)).toBe(TEMPORARY_FAILURE);
  });

  it("preserves standard user-facing messages", () => {
    const normal = "Logged 3 eggs and 2 slices of toast (350 kcal).";
    expect(sanitizeUserFacingError(normal)).toBe(normal);
  });
});


describe("explicit estimate-only requests", () => {
  it.each(["Estimate only", "Only calculate the calories", "Do not save anything", "Don't log this", "Don’t save a draft", "No saving please", "without persisting a draft"])("rejects writes for %s", text => {
    expect(isNoSaveRequest(text)).toBe(true);
    expect(isMealLogConfirmation(text)).toBe(false);
  });
  it.each(["Log it", "Please save this meal", "How many calories?"])("does not prohibit saving for %s", text => expect(isNoSaveRequest(text)).toBe(false));
  it("sanitizes a terminal 503 even without Google-specific text", () => expect(sanitizeUserFacingError("HTTP 503 SERVICE_UNAVAILABLE")).toBe(TEMPORARY_FAILURE));
});
