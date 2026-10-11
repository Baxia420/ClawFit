import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HealthDatabase } from "./client.js";
import { DEFAULT_PRIMARY_USER_ID as owner, DEFAULT_PARTNER_USER_ID as partner, HealthRepository } from "./repository.js";
import * as schema from "./schema.js";

const routineInput = { name: "Push", archived: false, exercises: [{ name: "Bench press", muscleGroup: "chest" as const, sets: 3, reps: 8, restSeconds: 90 }] };
describe("training migration and repository", () => {
  let pg: PGlite, repository: HealthRepository;
  beforeAll(async () => {
    pg = new PGlite();
    const files = (await readdir(new URL("../drizzle", import.meta.url))).filter(f => f.endsWith(".sql")).sort();
    for (const file of files.filter(f => !f.startsWith("0007"))) await pg.exec((await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")).replaceAll("--> statement-breakpoint", ""));
    repository = new HealthRepository(drizzle(pg, { schema }) as unknown as HealthDatabase);
    await expect(repository.checkReady()).rejects.toThrow();
    await pg.exec(`INSERT INTO workouts (user_id, name, status, started_at, finished_at, idempotency_key) VALUES ('${owner}', 'Existing session', 'finished', '2026-08-01T01:00Z', '2026-08-01T02:00Z', 'existing-training-session');`);
    await pg.exec((await readFile(new URL("../drizzle/0007_cooing_makkari.sql", import.meta.url), "utf8")).replaceAll("--> statement-breakpoint", ""));
  });
  afterAll(async () => { await pg?.close(); });
  it("applies the additive migration to existing records and keeps readiness honest", async () => {
    await expect(repository.checkReady()).resolves.toBe(true);
    const existing = await repository.workoutHistory(owner, 10);
    expect(existing.find(w => w.workout.idempotencyKey === "existing-training-session")?.workout).toMatchObject({ name: "Existing session", routineSnapshot: null });
  });
  it("corrects the same dated weigh-in without duplicating it or affecting another owner", async () => {
    await repository.saveWeight(owner, "2026-10-02", { weightKg: 80, notes: "Original" });
    await repository.saveWeight(partner, "2026-10-02", { weightKg: 60, notes: "Partner" });
    await repository.saveWeight(owner, "2026-10-02", { weightKg: 79.5, notes: "Correction" });
    await repository.setWeightGoal(owner, 75);
    expect(await repository.weightHistory(owner, "2026-10-02", "2026-10-03")).toEqual({ entries: [{ day: "2026-10-02", weightKg: 79.5, notes: "Correction" }], goalKg: 75 });
    expect(await repository.weightHistory(partner, "2026-10-02", "2026-10-03")).toEqual({ entries: [{ day: "2026-10-02", weightKg: 60, notes: "Partner" }], goalKg: null });
    expect((await repository.weightHistory(owner, "2026-10-03", "2026-10-04")).entries).toEqual([]);
    await repository.setWeightGoal(owner, null);
    expect((await repository.weightHistory(owner, "2026-10-02", "2026-10-03")).goalKg).toBeNull();
  });
  it("enforces routine ownership, optimistic versions and immutable session targets", async () => {
    const routine = await repository.saveRoutine(owner, { ...routineInput, idempotencyKey: "training-routine-one" });
    const retry = await repository.saveRoutine(owner, { ...routineInput, idempotencyKey: "training-routine-one" });
    expect(retry.id).toBe(routine.id);
    expect(await repository.listRoutines(partner)).toEqual([]);
    await expect(repository.setScheduleDay(partner, 1, routine.id)).rejects.toThrow("Routine not found");
    // The database itself also rejects an ownership mismatch.
    await expect(pg.query("INSERT INTO workout_schedule (user_id, weekday, routine_id) VALUES ($1, 1, $2)", [partner, routine.id])).rejects.toThrow();
    await repository.setScheduleDay(owner, 1, routine.id);
    await repository.setScheduleDay(owner, 1, routine.id);
    expect(await repository.getSchedule(owner)).toHaveLength(1);
    const workout = await repository.startWorkout(owner, { name: "ignored", routineId: routine.id, startedAt: new Date("2026-10-02T16:30Z"), idempotencyKey: "routine-workout-one" });
    const changed = await repository.updateRoutine(owner, routine.id, { ...routineInput, name: "New targets", exercises: [{ ...routineInput.exercises[0]!, reps: 12 }], version: routine.version });
    expect(changed.version).toBe(routine.version + 1);
    await expect(repository.updateRoutine(owner, routine.id, { ...routineInput, version: routine.version })).rejects.toThrow("changed on another device");
    await expect(repository.updateRoutine(partner, routine.id, { ...routineInput, version: changed.version })).rejects.toThrow("Routine not found");
    expect((await repository.getWorkout(owner, workout.workout.id)).workout.routineSnapshot?.exercises[0]?.reps).toBe(8);
    await repository.updateRoutine(owner, routine.id, { ...routineInput, archived: true, version: changed.version });
    expect(await repository.getSchedule(owner)).toEqual([]);
    await expect(repository.startWorkout(partner, { name: "Bad", routineId: routine.id, idempotencyKey: "partner-start-bad" })).rejects.toThrow("Routine not found");
    await repository.finishWorkout(owner, workout.workout.id, new Date("2026-10-02T17:00Z"));
  });
  it("deduplicates starts and sets, isolates completed stats and retains finish time on retry", async () => {
    const input = { name: "Stats session", startedAt: new Date("2026-10-03T16:30Z"), idempotencyKey: "stats-workout-one" };
    const workout = await repository.startWorkout(owner, input);
    expect((await repository.startWorkout(owner, input)).workout.id).toBe(workout.workout.id);
    await expect(repository.startWorkout(owner, { ...input, idempotencyKey: "another-active-key" })).rejects.toThrow("already active");
    const set = { exerciseName: "Bench press", muscleGroup: "chest" as const, weightKg: 80, reps: 8, idempotencyKey: "stats-set-one" };
    const first = await repository.addWorkoutSet(owner, workout.workout.id, set);
    expect((await repository.addWorkoutSet(owner, workout.workout.id, set)).id).toBe(first.id);
    const start = new Date("2026-10-03T16:00Z"), end = new Date("2026-10-04T16:00Z");
    expect((await repository.trainingStats(owner, start, end, "Asia/Kuala_Lumpur")).workoutCount).toBe(0);
    await repository.finishWorkout(owner, workout.workout.id, new Date("2026-10-03T17:30Z"));
    const finishedRetry = await repository.finishWorkout(owner, workout.workout.id, new Date("2026-10-03T19:30Z"));
    expect(finishedRetry.workout.finishedAt?.toISOString()).toBe("2026-10-03T17:30:00.000Z");
    expect(await repository.trainingStats(owner, start, end, "Asia/Kuala_Lumpur")).toMatchObject({ workoutCount: 1, totalSets: 1, totalReps: 8, volumeKg: 640, minutes: 60, muscleSets: { chest: 1, triceps: 0 }, activity: [{ day: "2026-10-04", sets: 1 }] });
    expect((await repository.trainingStats(partner, start, end, "Asia/Kuala_Lumpur")).workoutCount).toBe(0);
    await repository.updateWorkoutSet(owner, first.id, { weightKg: 75, reps: 10 });
    expect((await repository.trainingStats(owner, start, end, "Asia/Kuala_Lumpur")).volumeKg).toBe(750);
  });
});
