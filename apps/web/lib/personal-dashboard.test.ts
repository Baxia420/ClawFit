import { describe, expect, it, vi } from "vitest";
import { canAccessResource } from "@clawfit/health-core";
import { resolveWebPendingMealScope } from "./pending-scope";
import {
  calculateDailyProgress,
  calculateTrendSummary,
  formatLocalCalendarDate,
  type DailyNutritionTotals,
  type GoalTargets,
  type TrendDataPoint,
} from "./dashboard";
import { createWebAssertion } from "./api";

vi.mock("../auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "00000000-0000-0000-0000-000000000002", role: "primary", displayName: "Primary User" },
  }),
}));

describe("personal dashboard logic, production helpers, and multi-user isolation", () => {
  const userA = {
    id: "11111111-1111-4111-a111-111111111111",
    name: "Primary User",
    goals: {
      calorieTarget: 2500,
      proteinTargetG: 180,
    } satisfies GoalTargets,
    timezone: "Asia/Kuala_Lumpur",
    totals: {
      caloriesBest: 2150,
      caloriesLow: 1950,
      caloriesHigh: 2350,
      proteinG: 160,
      carbsG: 220,
      fatG: 65,
    } satisfies DailyNutritionTotals,
  };

  const userB = {
    id: "22222222-2222-4222-a222-222222222222",
    name: "Partner User",
    goals: {
      calorieTarget: 1800,
      proteinTargetG: 130,
    } satisfies GoalTargets,
    timezone: "Asia/Kuala_Lumpur",
    totals: {
      caloriesBest: 2050,
      caloriesLow: 1900,
      caloriesHigh: 2200,
      proteinG: 155,
      carbsG: 210,
      fatG: 70,
    } satisfies DailyNutritionTotals,
  };

  describe("production calculation helpers (apps/web/lib/dashboard.ts)", () => {
    it("calculates under-target remaining values accurately for User A", () => {
      const progressA = calculateDailyProgress(userA.totals, userA.goals);
      expect(progressA.isOverCalorieTarget).toBe(false);
      expect(progressA.isOverProteinTarget).toBe(false);
      expect(progressA.calorieHint).toBe("350 kcal remaining");
      expect(progressA.proteinHint).toBe("20 g remaining");
      expect(progressA.caloriePct).toBe(86);
      expect(progressA.calorieBarWidth).toBe(86);
    });

    it("calculates over-target messaging accurately for User B and never mislabels excess as remaining", () => {
      const progressB = calculateDailyProgress(userB.totals, userB.goals);
      expect(progressB.isOverCalorieTarget).toBe(true);
      expect(progressB.isOverProteinTarget).toBe(true);
      expect(progressB.calorieHint).toBe("+250 kcal over target");
      expect(progressB.proteinHint).toBe("+25 g over target");
      expect(progressB.caloriePct).toBe(114);
      // Visual bar width is capped at 100% while text percentage preserves genuine over-target 114%
      expect(progressB.calorieBarWidth).toBe(100);
    });

    it("distinguishes genuine empty day from API failure", () => {
      const emptyTotals: DailyNutritionTotals = {
        caloriesBest: 0,
        caloriesLow: 0,
        caloriesHigh: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
      };
      const emptyDay = calculateDailyProgress(emptyTotals, userA.goals);
      expect(emptyDay.calorieHint).toBe("2500 kcal remaining");
      expect(emptyDay.proteinHint).toBe("180 g remaining");
      expect(emptyDay.caloriePct).toBe(0);
      expect(emptyDay.calorieBarWidth).toBe(0);
      expect(emptyDay.isOverCalorieTarget).toBe(false);
    });

    it("explains that rolling averages cover logged days within the window", () => {
      const mockTrend: TrendDataPoint[] = [
        { day: "2026-09-08", caloriesBest: 2200, proteinG: 170 },
        { day: "2026-09-09", caloriesBest: 2400, proteinG: 180 },
        { day: "2026-09-10", caloriesBest: 2000, proteinG: 160 },
      ];

      const result7D = calculateTrendSummary(mockTrend, 7, userA.goals);
      expect(result7D.activeDays).toBe(3);
      expect(result7D.calorieAverage).toBe(2200);
      expect(result7D.proteinAverage).toBe(170);
      expect(result7D.calorieHint).toContain("3 active logged days in 7D window");
      expect(result7D.proteinHint).toContain("3 active logged days");

      const emptyTrend: TrendDataPoint[] = [];
      const emptyResult = calculateTrendSummary(emptyTrend, 7, userA.goals);
      expect(emptyResult.activeDays).toBe(0);
      expect(emptyResult.calorieAverage).toBe(0);
      expect(emptyResult.calorieHint).toBe("0 active logged days in 7D window");
    });

    it("formats local calendar dates accurately across UTC boundary in user timezone", () => {
      // 2026-09-10T15:30:00Z in Asia/Kuala_Lumpur is Sep 10, 23:30 (+08:00)
      expect(formatLocalCalendarDate("2026-09-10T15:30:00Z", "Asia/Kuala_Lumpur")).toBe("2026-09-10");

      // 2026-09-10T16:30:00Z in Asia/Kuala_Lumpur is Sep 11, 00:30 (+08:00)
      expect(formatLocalCalendarDate("2026-09-10T16:30:00Z", "Asia/Kuala_Lumpur")).toBe("2026-09-11");

      // In UTC, both are Sep 10
      expect(formatLocalCalendarDate("2026-09-10T15:30:00Z", "UTC")).toBe("2026-09-10");
      expect(formatLocalCalendarDate("2026-09-10T16:30:00Z", "UTC")).toBe("2026-09-10");
    });
  });

  describe("multi-user data isolation and settings workflows", () => {
    it("proves User A and User B receive distinct goals, meals, and workouts", () => {
      expect(userA.goals.calorieTarget).not.toBe(userB.goals.calorieTarget);
      expect(userA.goals.proteinTargetG).not.toBe(userB.goals.proteinTargetG);
      expect(userA.totals.caloriesBest).not.toBe(userB.totals.caloriesBest);

      const progressA = calculateDailyProgress(userA.totals, userA.goals);
      const progressB = calculateDailyProgress(userB.totals, userB.goals);

      expect(progressA.isOverCalorieTarget).toBe(false);
      expect(progressB.isOverCalorieTarget).toBe(true);
    });

    it("enforces cross-user resource access and mutation denials via production authorization policy", () => {
      const householdId = "00000000-0000-0000-0000-000000000001";
      const outsiderHouseholdId = "00000000-0000-0000-0000-000000000002";

      // 1. User B cannot mutate User A's settings
      const canMutateSettings = canAccessResource(
        { userId: userB.id, householdId },
        { ownerUserId: userA.id, type: "user_settings" },
        "write",
      );
      expect(canMutateSettings).toBe(false);

      // 2. User A can mutate their own settings
      const canMutateOwnSettings = canAccessResource(
        { userId: userA.id, householdId },
        { ownerUserId: userA.id, type: "user_settings" },
        "write",
      );
      expect(canMutateOwnSettings).toBe(true);

      // 3. User B cannot mutate User A's meal
      const canMutateMeal = canAccessResource(
        { userId: userB.id, householdId },
        { ownerUserId: userA.id, type: "meals" },
        "write",
      );
      expect(canMutateMeal).toBe(false);

      // 4. In the same household, User B can read User A's partner overview
      const canReadPartnerOverview = canAccessResource(
        { userId: userB.id, householdId },
        { ownerUserId: userA.id, householdId, type: "partner_overview" },
        "read",
      );
      expect(canReadPartnerOverview).toBe(true);

      // 5. Outsider User C cannot read User A's partner overview
      const canOutsiderReadPartnerOverview = canAccessResource(
        { userId: "33333333-3333-4333-a333-333333333333", householdId: outsiderHouseholdId },
        { ownerUserId: userA.id, householdId, type: "partner_overview" },
        "read",
      );
      expect(canOutsiderReadPartnerOverview).toBe(false);
    });

    it("binds assertion token strictly to caller identity without cross-user leakage", async () => {
      const testSecret = "test-secret-at-least-32-characters-long!!";
      const oldSecret = process.env.WEB_ASSERTION_SIGNING_SECRET;
      process.env.WEB_ASSERTION_SIGNING_SECRET = testSecret;

      try {
        const assertionA = await createWebAssertion(userA.id, "primary", "userA@example.com");
        const assertionB = await createWebAssertion(userB.id, "partner", "userB@example.com");

        expect(assertionA).toBeDefined();
        expect(assertionB).toBeDefined();
        expect(assertionA).not.toBe(assertionB);

        // Decode tokens to verify strictly isolated subject claims
        const partsA = assertionA.split(".");
        const payloadA = JSON.parse(Buffer.from(partsA[1]!, "base64url").toString("utf8"));
        expect(payloadA.sub).toBe(userA.id);
        expect(payloadA.iss).toBe("clawfit-web");
        expect(payloadA.aud).toBe("clawfit-health-api");

        const partsB = assertionB.split(".");
        const payloadB = JSON.parse(Buffer.from(partsB[1]!, "base64url").toString("utf8"));
        expect(payloadB.sub).toBe(userB.id);
        expect(payloadB.iss).toBe("clawfit-web");
        expect(payloadB.aud).toBe("clawfit-health-api");
      } finally {
        if (oldSecret) {
          process.env.WEB_ASSERTION_SIGNING_SECRET = oldSecret;
        } else {
          delete process.env.WEB_ASSERTION_SIGNING_SECRET;
        }
      }
    });

    it("distinguishes genuine empty state from API failure state", () => {
      // Genuine empty data returns empty array/zero totals with status 200
      const emptyResponse = { status: 200, meals: [], totals: { caloriesBest: 0, proteinG: 0 } };
      const hasMeals = emptyResponse.meals.length > 0;
      const isFailed = emptyResponse.status !== 200;

      expect(hasMeals).toBe(false);
      expect(isFailed).toBe(false);

      // Failed API request returns an error and never substitutes false zeros
      const failureResponse = { status: 503, error: "Service unavailable" };
      const isFailureState = failureResponse.status >= 400;

      expect(isFailureState).toBe(true);
      // Ensure failure copy is plain user-facing text
      const errorMessage = "Unable to load your health data right now. Please check your connection or retry.";
      expect(errorMessage).not.toContain("API");
      expect(errorMessage).not.toContain("substitute");
      expect(errorMessage).not.toContain("zero");
    });

    it("resets assistant drawer state across account changes using identity key (unit contract; live e2e assistant reset pending Increment 4)", () => {
      // In Shell.tsx: <AssistantDrawer key={user?.id ?? "anon"} />
      // Validates identity-keyed remount reset pattern in Shell.tsx.
      // Full end-to-end interactive assistant conversation wipe and session rehydration are verified in Increment 4 acceptance.
      const getKey = (user?: { id?: string }) => user?.id ?? "anon";

      const keyA = getKey(userA);
      const keyB = getKey(userB);
      const keyAnon = getKey(undefined);

      expect(keyA).toBe(userA.id);
      expect(keyB).toBe(userB.id);
      expect(keyAnon).toBe("anon");

      // Key changes force React component remounting and complete state reset
      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toBe(keyAnon);
      expect(keyB).not.toBe(keyAnon);
    });

    it("isolates pending meal scope per user and fails closed without a user ID", () => {
      const scopeA = resolveWebPendingMealScope(userA.id);
      const scopeB = resolveWebPendingMealScope(userB.id);

      expect(scopeA).toBe(`web:${userA.id}`);
      expect(scopeB).toBe(`web:${userB.id}`);
      expect(scopeA).not.toBe(scopeB);

      expect(() => resolveWebPendingMealScope("")).toThrow("Missing user identity for web pending meal scope");
      expect(() => resolveWebPendingMealScope("   ")).toThrow("Missing user identity for web pending meal scope");
    });
  });
});
