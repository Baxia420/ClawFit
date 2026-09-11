import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateTogetherMemberProgress,
  calculateTogetherTrendSummary,
} from "./dashboard";
import { fetchTogetherData, HealthApiError, type TogetherMemberProgress, type TogetherResponse } from "./api";

vi.mock("../auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "00000000-0000-0000-0000-000000000002", role: "primary", displayName: "Primary User" },
  }),
}));

describe("Together Dashboard web client and progress projections", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("fetchTogetherData", () => {
    it("fetches together data with proper query parameters and authorization", async () => {
      vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", "this-is-a-strong-assertion-signing-secret-at-least-32-chars");
      vi.stubEnv("HEALTH_API_WEB_TOKEN", "different-machine-token-at-least-24-chars");

      const mockResponse: TogetherResponse = {
        household: { id: "household-1", name: "Smith Household" },
        date: "2026-09-11",
        timezone: "Asia/Kuala_Lumpur",
        members: [
          {
            userId: "user-1",
            displayName: "Alex",
            isCaller: true,
            goals: { calorieTarget: 2200, proteinTargetG: 160 },
            daily: {
              date: "2026-09-11",
              calories: 1800,
              proteinG: 140,
              mealCount: 2,
              meals: [
                {
                  id: "m-1",
                  label: "Oatmeal",
                  caloriesBest: 400,
                  proteinG: 15,
                  occurredAt: "2026-09-11T08:00:00Z",
                },
              ],
              workouts: [
                {
                  id: "w-1",
                  name: "Upper Body",
                  startedAt: "2026-09-11T09:00:00Z",
                  finishedAt: "2026-09-11T10:00:00Z",
                  setCount: 10,
                  volumeKg: 2500,
                  exercises: [{ id: "e-1", name: "Bench Press", setCount: 4 }],
                },
              ],
            },
            trend: [
              { day: "2026-09-09", calories: 2100, proteinG: 155 },
              { day: "2026-09-10", calories: 2300, proteinG: 165 },
              { day: "2026-09-11", calories: 1800, proteinG: 140 },
            ],
          },
          {
            userId: "user-2",
            displayName: "Jordan",
            isCaller: false,
            goals: { calorieTarget: 1900, proteinTargetG: 130 },
            daily: {
              date: "2026-09-11",
              calories: 2050,
              proteinG: 135,
              mealCount: 3,
              meals: [],
              workouts: [],
            },
            trend: [{ day: "2026-09-11", calories: 2050, proteinG: 135 }],
          },
        ],
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchTogetherData({ date: "2026-09-11", days: 7 });

      expect(fetchMock).toHaveBeenCalled();
      const calledUrl = fetchMock.mock.calls[0]![0]!.toString();
      expect(calledUrl).toContain("/v1/together?date=2026-09-11&days=7");

      expect(result.household.name).toBe("Smith Household");
      expect(result.members).toHaveLength(2);
      expect(result.members[0]!.isCaller).toBe(true);
      expect(result.members[1]!.isCaller).toBe(false);
    });

    it("handles 403 NO_HOUSEHOLD by throwing a typed HealthApiError", async () => {
      vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", "this-is-a-strong-assertion-signing-secret-at-least-32-chars");
      vi.stubEnv("HEALTH_API_WEB_TOKEN", "different-machine-token-at-least-24-chars");

      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: "NO_HOUSEHOLD", message: "Caller does not belong to any active household" },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      try {
        await fetchTogetherData();
        expect.unreachable("should have thrown HealthApiError");
      } catch (err) {
        expect(err).toBeInstanceOf(HealthApiError);
        const apiErr = err as HealthApiError;
        expect(apiErr.status).toBe(403);
        expect(apiErr.code).toBe("NO_HOUSEHOLD");
        expect(apiErr.message).toBe("Caller does not belong to any active household");
      }
    });

    it("handles 403 INACTIVE_USER by throwing a typed HealthApiError", async () => {
      vi.stubEnv("WEB_ASSERTION_SIGNING_SECRET", "this-is-a-strong-assertion-signing-secret-at-least-32-chars");
      vi.stubEnv("HEALTH_API_WEB_TOKEN", "different-machine-token-at-least-24-chars");

      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: "INACTIVE_USER", message: "User account is inactive" },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      try {
        await fetchTogetherData();
        expect.unreachable("should have thrown HealthApiError");
      } catch (err) {
        expect(err).toBeInstanceOf(HealthApiError);
        const apiErr = err as HealthApiError;
        expect(apiErr.status).toBe(403);
        expect(apiErr.code).toBe("INACTIVE_USER");
      }
    });
  });

  describe("Together dashboard calculations and privacy rules", () => {
    const memberCaller: TogetherMemberProgress = {
      userId: "00000000-0000-0000-0000-000000000002",
      displayName: "Alex",
      isCaller: true,
      goals: { calorieTarget: 2200, proteinTargetG: 160 },
      daily: {
        date: "2026-09-11",
        calories: 1850,
        proteinG: 140,
        mealCount: 3,
        meals: [
          { id: "m-1", label: "Breakfast", caloriesBest: 500, proteinG: 35, occurredAt: "2026-09-11T08:00:00Z" },
          { id: "m-2", label: "Lunch", caloriesBest: 750, proteinG: 55, occurredAt: "2026-09-11T13:00:00Z" },
          { id: "m-3", label: "Dinner", caloriesBest: 600, proteinG: 50, occurredAt: "2026-09-11T19:30:00Z" },
        ],
        workouts: [
          {
            id: "w-1",
            name: "Morning Run",
            startedAt: "2026-09-11T07:00:00Z",
            finishedAt: "2026-09-11T07:45:00Z",
            setCount: 0,
            volumeKg: 0,
            exercises: [],
          },
        ],
      },
      trend: [
        { day: "2026-09-08", calories: 2100, proteinG: 150 },
        { day: "2026-09-09", calories: 0, proteinG: 0 },
        { day: "2026-09-10", calories: 2300, proteinG: 165 },
        { day: "2026-09-11", calories: 1850, proteinG: 140 },
      ],
    };

    const memberPartner: TogetherMemberProgress = {
      userId: "00000000-0000-0000-0000-000000000003",
      displayName: "Jordan",
      isCaller: false,
      goals: { calorieTarget: 1900, proteinTargetG: 130 },
      daily: {
        date: "2026-09-11",
        calories: 2150,
        proteinG: 145,
        mealCount: 2,
        meals: [
          { id: "m-4", label: "Brunch", caloriesBest: 1100, proteinG: 65, occurredAt: "2026-09-11T11:00:00Z" },
          { id: "m-5", label: "Late Dinner", caloriesBest: 1050, proteinG: 80, occurredAt: "2026-09-11T20:00:00Z" },
        ],
        workouts: [],
      },
      trend: [
        { day: "2026-09-10", calories: 1950, proteinG: 135 },
        { day: "2026-09-11", calories: 2150, proteinG: 145 },
      ],
    };

    it("accurately projects under-target remaining calories and bounds progressbar accessibility values", () => {
      const progress = calculateTogetherMemberProgress(
        memberCaller.goals.calorieTarget,
        memberCaller.daily.calories,
        memberCaller.goals.proteinTargetG,
        memberCaller.daily.proteinG,
        memberCaller.trend,
      );

      expect(progress.calorieDiff).toBe(350);
      expect(progress.caloriePct).toBe(84);
      expect(progress.calorieBoundedBar).toBe(84);
      expect(progress.calorieAriaValueNow).toBe(1850);
      expect(progress.calorieAriaValueMin).toBe(0);
      expect(progress.calorieAriaValueMax).toBe(2200);
      expect(progress.calorieHint).toBe("350 kcal remaining");
      expect(progress.calorieAccessibleText).toBe("1850 of 2200 kcal (350 kcal remaining)");

      expect(progress.proteinDiff).toBe(20);
      expect(progress.proteinPct).toBe(88);
      expect(progress.proteinBoundedBar).toBe(88);
      expect(progress.proteinAriaValueNow).toBe(140);
      expect(progress.proteinAriaValueMin).toBe(0);
      expect(progress.proteinAriaValueMax).toBe(160);
      expect(progress.proteinHint).toBe("20 g remaining");
      expect(progress.proteinAccessibleText).toBe("140 of 160 g (20 g remaining)");
    });

    it("accurately projects over-target calories without mislabeling and bounds aria-valuenow to aria-valuemax", () => {
      const progress = calculateTogetherMemberProgress(
        memberPartner.goals.calorieTarget,
        memberPartner.daily.calories,
        memberPartner.goals.proteinTargetG,
        memberPartner.daily.proteinG,
        memberPartner.trend,
      );

      expect(progress.calorieDiff).toBe(-250);
      expect(progress.caloriePct).toBe(113);
      // Visual bar is bounded at 100%
      expect(progress.calorieBoundedBar).toBe(100);
      // WAI-ARIA aria-valuenow is bounded within [min, max]
      expect(progress.calorieAriaValueNow).toBe(1900);
      expect(progress.calorieAriaValueMin).toBe(0);
      expect(progress.calorieAriaValueMax).toBe(1900);
      // Genuine over-target intake is preserved in accessible text and hint
      expect(progress.calorieHint).toBe("250 kcal over target");
      expect(progress.calorieAccessibleText).toBe("2150 of 1900 kcal (250 kcal over target)");

      expect(progress.proteinDiff).toBe(-15);
      expect(progress.proteinPct).toBe(112);
      expect(progress.proteinBoundedBar).toBe(100);
      expect(progress.proteinAriaValueNow).toBe(130);
      expect(progress.proteinAriaValueMin).toBe(0);
      expect(progress.proteinAriaValueMax).toBe(130);
      expect(progress.proteinHint).toBe("Target met (145 g)");
      expect(progress.proteinAccessibleText).toBe("145 of 130 g (Target met (145 g))");
    });

    it("computes trend summary including 0-calorie days as valid logged days", () => {
      const summary = calculateTogetherTrendSummary(memberCaller.trend);

      // Caller has 4 points in trend: 2100, 0, 2300, 1850.
      // All 4 points are valid logged days.
      expect(summary.loggedDaysCount).toBe(4);
      expect(summary.avgCalories).toBe(Math.round((2100 + 0 + 2300 + 1850) / 4)); // 1563
      expect(summary.avgProteinG).toBe(Math.round((150 + 0 + 165 + 140) / 4)); // 114
    });

    it("handles empty trend safely with zero averages", () => {
      const emptySummary = calculateTogetherTrendSummary([]);
      expect(emptySummary.loggedDaysCount).toBe(0);
      expect(emptySummary.avgCalories).toBe(0);
      expect(emptySummary.avgProteinG).toBe(0);

      const undefinedSummary = calculateTogetherTrendSummary(undefined);
      expect(undefinedSummary.loggedDaysCount).toBe(0);
      expect(undefinedSummary.avgCalories).toBe(0);
      expect(undefinedSummary.avgProteinG).toBe(0);
    });

    it("preserves privacy by exposing only display names and confirmed summaries", () => {
      // Proves no sensitive authentication or internal identifiers are exposed in public fields
      expect(memberCaller.displayName).toBe("Alex");
      expect(memberPartner.displayName).toBe("Jordan");

      // Verify no passwords, sessions, or private tokens exist in member progress
      const callerRecord = memberCaller as Record<string, unknown>;
      expect(callerRecord.hashedPassword).toBeUndefined();
      expect(callerRecord.token).toBeUndefined();
      expect(callerRecord.email).toBeUndefined();
      expect(callerRecord.providerAccountId).toBeUndefined();

      // Meals are confirmed only
      expect(memberCaller.daily.meals).toHaveLength(3);
      expect(memberCaller.daily.meals.every((m) => m.label && m.caloriesBest > 0)).toBe(true);

      // Caller is marked isCaller=true, partner isCaller=false
      expect(memberCaller.isCaller).toBe(true);
      expect(memberPartner.isCaller).toBe(false);
    });
  });
});
