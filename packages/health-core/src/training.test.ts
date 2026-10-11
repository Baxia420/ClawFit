import { describe, expect, it } from "vitest";
import { muscleForExercise, routineDefinitionSchema, summarizeTraining, trainingDateSchema, weightTrend, type TrainingSession } from "./training.js";

describe("training calculations", () => {
  it("counts primary muscles once, excludes bodyweight from external volume and groups by local start date", () => {
    const sessions: TrainingSession[] = [{ id: "a", name: "Mixed", startedAt: "2026-10-02T16:30:00Z", finishedAt: "2026-10-02T17:30:00Z", exercises: [
      { name: "Bench press", muscleGroup: null, sets: [{ weightKg: 80, reps: 8 }, { weightKg: 60, reps: 15 }] },
      { name: "Custom movement", muscleGroup: "glutes", sets: [{ weightKg: null, reps: 12 }] },
      { name: "Unknown movement", muscleGroup: null, sets: [{ weightKg: 10, reps: 20 }] },
    ] }];
    const result = summarizeTraining(sessions, "Asia/Kuala_Lumpur");
    expect(result).toMatchObject({ workoutCount: 1, activeDays: 1, totalSets: 4, totalReps: 55, volumeKg: 1740, minutes: 60 });
    expect(result.activity[0]?.day).toBe("2026-10-03");
    expect(result.muscleSets).toMatchObject({ chest: 2, glutes: 1, other: 1, triceps: 0 });
    expect(Object.values(result.muscleSets).reduce((a,b) => a+b,0)).toBe(result.totalSets);
    expect(result.records.find(r => r.name === "Bench press")?.estimatedOneRepMax).toBeCloseTo(101.3, 0);
    expect(result.records.find(r => r.name === "Unknown movement")?.estimatedOneRepMax).toBeNull();
    expect(result.records.find(r => r.name === "Custom movement")?.bestWeightKg).toBeNull();
  });
  it("uses a calendar seven-day sample window without inventing missing weights", () => {
    const series = weightTrend([{ day: "2026-10-09", weightKg: 78, notes: "" }, { day: "2026-10-01", weightKg: 90, notes: "" }, { day: "2026-10-03", weightKg: 80, notes: "" }]);
    expect(series.map(p => [p.day,p.averageKg])).toEqual([["2026-10-01",90],["2026-10-03",85],["2026-10-09",79]]);
    expect(series).toHaveLength(3);
    expect(series[2]!.timestamp - series[1]!.timestamp).toBe(6 * 86_400_000);
  });
  it("keeps unknown names unclassified and validates real dates and nonduplicate exercise targets", () => {
    expect(muscleForExercise("  BENCH  PRESS ")).toBe("chest");
    expect(muscleForExercise("Mystery row machine")).toBe("other");
    expect(trainingDateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(trainingDateSchema.safeParse("2028-02-29").success).toBe(true);
    const row = { name: "Bench press", muscleGroup: "chest", sets: 3, reps: 8, restSeconds: 90 };
    expect(routineDefinitionSchema.safeParse({ name: "Push", exercises: [row, { ...row, name: " BENCH  PRESS " }] }).success).toBe(false);
    expect(summarizeTraining([], "Asia/Kuala_Lumpur")).toMatchObject({ totalSets: 0, workoutCount: 0, volumeKg: 0, records: [], activity: [] });
  });
});
