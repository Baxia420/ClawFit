import { expect, it } from "vitest";
import { readGoogleCredentials } from "./google-credentials.js";

it("keeps stable slot labels, handles gaps, and deduplicates identical keys", () => {
  const values = readGoogleCredentials({ GEMINI_API_KEY: "fake-primary", GEMINI_API_KEY_1: " fake-primary ", GEMINI_API_KEY_3: "fake-backup" });
  expect(values).toEqual([{ id: "primary", envName: "GEMINI_API_KEY", apiKey: "fake-primary" }, { id: "backup-3", envName: "GEMINI_API_KEY_3", apiKey: "fake-backup" }]);
  expect(readGoogleCredentials({})).toEqual([]);
});
it("rejects missing primary, unsupported slots, and malformed secrets without displaying values", () => {
  expect(() => readGoogleCredentials({ GEMINI_API_KEY_1: "fake-backup" })).toThrow("required");
  expect(() => readGoogleCredentials({ GEMINI_API_KEY: "fake", GEMINI_API_KEY_9: "private" })).toThrow("slots");
  try { readGoogleCredentials({ GEMINI_API_KEY: "private value\nwith newlines" }); throw new Error("expected rejection"); }
  catch (error) { expect(String(error)).toContain("values are hidden"); expect(String(error)).not.toContain("private"); }
});
