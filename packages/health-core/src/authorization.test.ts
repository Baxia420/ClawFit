import { describe, expect, it } from "vitest";
import {
  buildWebPendingMealScope,
  canAccessResource,
  isUserPendingMealScope,
  type ActorContext,
  type ResourceDescriptor,
} from "./authorization.js";

describe("authorization foundation", () => {
  const primaryUserId = "00000000-0000-0000-0000-000000000002";
  const partnerUserId = "00000000-0000-0000-0000-000000000003";
  const strangerUserId = "00000000-0000-0000-0000-000000000099";
  const householdId = "00000000-0000-0000-0000-000000000001";
  const otherHouseholdId = "00000000-0000-0000-0000-000000000999";

  const primaryActor: ActorContext = { userId: primaryUserId, householdId, role: "primary" };
  const partnerActor: ActorContext = { userId: partnerUserId, householdId, role: "partner" };
  const strangerActor: ActorContext = { userId: strangerUserId, householdId: otherHouseholdId, role: "primary" };

  it("permits actor full access (read, write, delete) over own resources", () => {
    const ownMeal: ResourceDescriptor = { ownerUserId: primaryUserId, householdId, type: "meals" };
    const ownDraft: ResourceDescriptor = { ownerUserId: primaryUserId, householdId, type: "pending_drafts" };
    const ownSettings: ResourceDescriptor = { ownerUserId: primaryUserId, householdId, type: "user_settings" };

    expect(canAccessResource(primaryActor, ownMeal, "read")).toBe(true);
    expect(canAccessResource(primaryActor, ownMeal, "write")).toBe(true);
    expect(canAccessResource(primaryActor, ownMeal, "delete")).toBe(true);

    expect(canAccessResource(primaryActor, ownDraft, "read")).toBe(true);
    expect(canAccessResource(primaryActor, ownDraft, "write")).toBe(true);
    expect(canAccessResource(primaryActor, ownDraft, "delete")).toBe(true);

    expect(canAccessResource(primaryActor, ownSettings, "read")).toBe(true);
    expect(canAccessResource(primaryActor, ownSettings, "write")).toBe(true);
  });

  it("strictly denies all partner mutations even within the same household", () => {
    const partnerMeal: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "meals" };
    const partnerWorkout: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "workouts" };

    expect(canAccessResource(primaryActor, partnerMeal, "write")).toBe(false);
    expect(canAccessResource(primaryActor, partnerMeal, "delete")).toBe(false);
    expect(canAccessResource(primaryActor, partnerWorkout, "write")).toBe(false);
    expect(canAccessResource(primaryActor, partnerWorkout, "delete")).toBe(false);
  });

  it("permits read-only access to partner health data within the same household", () => {
    const partnerMeal: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "meals" };
    const partnerWorkout: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "workouts" };
    const partnerOverview: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "partner_overview" };

    expect(canAccessResource(primaryActor, partnerMeal, "read")).toBe(true);
    expect(canAccessResource(primaryActor, partnerWorkout, "read")).toBe(true);
    expect(canAccessResource(primaryActor, partnerOverview, "read")).toBe(true);

    // Reciprocal check: partner can also read primary's meals
    expect(canAccessResource(partnerActor, { ownerUserId: primaryUserId, householdId, type: "meals" }, "read")).toBe(true);
  });

  it("denies access to partner drafts, private settings, and notification preferences", () => {
    const partnerDraft: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "pending_drafts" };
    const partnerSettings: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "user_settings" };
    const partnerPrefs: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "notification_preferences" };
    const partnerIdentities: ResourceDescriptor = { ownerUserId: partnerUserId, householdId, type: "external_identities" };

    expect(canAccessResource(primaryActor, partnerDraft, "read")).toBe(false);
    expect(canAccessResource(primaryActor, partnerSettings, "read")).toBe(false);
    expect(canAccessResource(primaryActor, partnerPrefs, "read")).toBe(false);
    expect(canAccessResource(primaryActor, partnerIdentities, "read")).toBe(false);
  });

  it("denies any access to users in an unrelated household", () => {
    const strangerMeal: ResourceDescriptor = { ownerUserId: strangerUserId, householdId: otherHouseholdId, type: "meals" };

    expect(canAccessResource(primaryActor, strangerMeal, "read")).toBe(false);
    expect(canAccessResource(primaryActor, strangerMeal, "write")).toBe(false);
    expect(canAccessResource(primaryActor, strangerMeal, "delete")).toBe(false);

    expect(canAccessResource(strangerActor, { ownerUserId: primaryUserId, householdId, type: "meals" }, "read")).toBe(false);
  });

  it("constructs and verifies dynamic user-scoped pending meal scopes", () => {
    expect(buildWebPendingMealScope(primaryUserId)).toBe(`web:${primaryUserId}`);
    expect(buildWebPendingMealScope(partnerUserId)).toBe(`web:${partnerUserId}`);

    expect(isUserPendingMealScope(`web:${primaryUserId}`, primaryUserId)).toBe(true);
    expect(isUserPendingMealScope(`web:${partnerUserId}`, primaryUserId)).toBe(false);

    expect(() => buildWebPendingMealScope("")).toThrow("A valid userId is required");
  });
});
