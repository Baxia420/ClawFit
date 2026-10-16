import { expect, it } from "vitest";
import { isNutritionSourceQuestion, NUTRITION_BASIS, nutritionReply, readReplyEstimate } from "./nutrition-reply.js";

const estimate = { label: "Biscuits", calories: { best: 210, low: 180, high: 250 }, macros: { proteinG: 2.5, carbsG: 30, fatG: 9, fiberG: null }, confidence: "low" as const, uncertaintyReasons: ["Packet weight assumed; label not supplied"] };

it("uses only API values and always preserves range, confidence, assumptions and logging state", () => {
  const reply = nutritionReply(estimate, false, false);
  expect(reply).toContain("210 kcal (180–250)");
  expect(reply).toContain("Confidence: low");
  expect(reply).toContain("Packet weight assumed");
  expect(reply).toContain("not verified against an online product source");
  expect(reply).toContain("Reply yes to log it");
  expect(reply).not.toContain("Fiber:");
  expect(nutritionReply(estimate, false, true)).not.toContain("Reply yes");
  expect(nutritionReply(estimate, true, false)).toContain("\nLogged.");
  expect(nutritionReply(estimate, true, false)).not.toContain("Not logged");
});

it("validates API responses before preparing a reply", () => {
  expect(readReplyEstimate({ estimate })).toEqual(estimate);
  expect(readReplyEstimate({ ...estimate, calories: { best: 210, low: 300, high: 250 } })).toBeUndefined();
  expect(readReplyEstimate({ ...estimate, confidence: "certain" })).toBeUndefined();
  expect(readReplyEstimate({ estimate: { label: "Incomplete API reply" } })).toBeUndefined();
});

it("answers the observed source question truthfully without intercepting write requests", () => {
  expect(isNutritionSourceQuestion("Did you Look up the values online? How did calculation came across")).toBe(true);
  expect(isNutritionSourceQuestion("Where did those calorie numbers come from?")).toBe(true);
  expect(isNutritionSourceQuestion("How did you calculate the calories?")).toBe(true);
  expect(isNutritionSourceQuestion("Save the nutrition values I found online")).toBe(false);
  expect(isNutritionSourceQuestion("Look up my workout plan")).toBe(false);
  expect(NUTRITION_BASIS).toContain("no online lookup");
});
