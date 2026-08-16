import { describe, expect, it } from "vitest";
import { isMealLogConfirmation } from "./confirmation.js";

describe("meal log confirmation", () => {
  it.each(["log it", "save it", "track this", "yes", "Okay!", "make it 500 and log it"])("accepts %s", (prompt) => {
    expect(isMealLogConfirmation(prompt)).toBe(true);
  });

  it.each(["I ate 3 eggs and toast", "estimate this meal", "what have I eaten today?"])("rejects %s", (prompt) => {
    expect(isMealLogConfirmation(prompt)).toBe(false);
  });
});
