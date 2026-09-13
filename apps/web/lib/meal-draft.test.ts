import { describe, expect, it } from "vitest";
import {
  serializeMealContext,
  deserializeMealContext,
  parseAuthoritativeDraft,
} from "./meal-flow-helpers";

describe("Meal draft context and authoritative parsing", () => {
  it("serializes and deserializes context with revisionOpId", () => {
    const raw = serializeMealContext(
      "Chicken and broccoli",
      "Cooked in olive oil",
      ["less oil", "extra chicken"],
      "op_rev_12345",
    );

    const parsed = deserializeMealContext(raw);
    expect(parsed.text).toBe("Chicken and broccoli");
    expect(parsed.notes).toBe("Cooked in olive oil");
    expect(parsed.revisionHistory).toEqual(["less oil", "extra chicken"]);
    expect(parsed.revisionOpId).toBe("op_rev_12345");
  });

  it("handles legacy plain text fallback gracefully", () => {
    const parsed = deserializeMealContext("Plain text description without JSON");
    expect(parsed.text).toBe("Plain text description without JSON");
    expect(parsed.notes).toBe("");
    expect(parsed.revisionHistory).toEqual([]);
    expect(parsed.revisionOpId).toBeUndefined();
  });

  it("handles empty or null context safely", () => {
    expect(deserializeMealContext(null)).toEqual({ text: "", notes: "", revisionHistory: [] });
    expect(deserializeMealContext("")).toEqual({ text: "", notes: "", revisionHistory: [] });
    expect(deserializeMealContext("   ")).toEqual({ text: "", notes: "", revisionHistory: [] });
  });

  it("parses authoritative draft and separates confirmed / active / cancelled states", () => {
    const activeRaw = {
      id: "draft-uuid-1",
      label: "Grilled Salmon",
      items: [{ name: "Salmon", portionDescription: "1 fillet", calories: 350 }],
      caloriesBest: 350,
      caloriesLow: 320,
      caloriesHigh: 380,
      proteinG: 34,
      carbsG: 0,
      fatG: 18,
      fiberG: null,
      confidence: "high",
      uncertaintyReasons: ["Fillet thickness estimated"],
      source: "text",
      idempotencyKey: "draft_op_salmon_1",
      version: 2,
      confirmed: false,
      cancelledAt: null,
      rawUserText: serializeMealContext("Salmon", "Wild caught", [], "op_rev_salmon_v2"),
    };

    const parsedActive = parseAuthoritativeDraft(activeRaw);
    expect(parsedActive.confirmed).toBe(false);
    expect(parsedActive.cancelled).toBe(false);
    expect(parsedActive.draft.id).toBe("draft-uuid-1");
    expect(parsedActive.draft.version).toBe(2);
    expect(parsedActive.draft.calories.best).toBe(350);
    expect(parsedActive.context.revisionOpId).toBe("op_rev_salmon_v2");
    expect(parsedActive.context.notes).toBe("Wild caught");

    // Confirmed state
    const confirmedRaw = {
      ...activeRaw,
      confirmed: true,
      confirmedAt: "2026-09-12T12:30:00Z",
    };
    const parsedConfirmed = parseAuthoritativeDraft(confirmedRaw);
    expect(parsedConfirmed.confirmed).toBe(true);
    expect(parsedConfirmed.cancelled).toBe(false);

    // Cancelled state
    const cancelledRaw = {
      ...activeRaw,
      confirmed: false,
      cancelledAt: "2026-09-12T12:35:00Z",
    };
    const parsedCancelled = parseAuthoritativeDraft(cancelledRaw);
    expect(parsedCancelled.confirmed).toBe(false);
    expect(parsedCancelled.cancelled).toBe(true);
  });
});
