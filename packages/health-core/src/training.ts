import { z } from "zod";
import { isValidCalendarDate, estimatedOneRepMax, getZonedCalendarDate, workoutVolume } from "./calculations.js";

export const muscleGroups = ["chest", "back", "shoulders", "biceps", "triceps", "core", "quads", "hamstrings", "glutes", "calves", "other"] as const;
export const muscleGroupSchema = z.enum(muscleGroups);
export type MuscleGroup = z.infer<typeof muscleGroupSchema>;
export const muscleLabels: Record<MuscleGroup, string> = { chest: "Chest", back: "Back", shoulders: "Shoulders", biceps: "Biceps", triceps: "Triceps", core: "Core", quads: "Quads", hamstrings: "Hamstrings", glutes: "Glutes", calves: "Calves", other: "Unclassified" };
export const trainingDateSchema = z.string().refine(isValidCalendarDate, "Use a valid calendar date");
export const weightEntrySchema = z.object({ weightKg: z.number().min(20).max(400), notes: z.string().trim().max(500).default("") });
export const weightGoalSchema = z.object({ goalKg: z.number().min(20).max(400).nullable() });
export const routineExerciseSchema = z.object({ name: z.string().trim().min(1).max(160), muscleGroup: muscleGroupSchema, sets: z.number().int().min(1).max(20), reps: z.number().int().min(1).max(100), restSeconds: z.number().int().min(0).max(900).default(90) });
export const routineDefinitionSchema = z.object({ name: z.string().trim().min(1).max(120), exercises: z.array(routineExerciseSchema).min(1).max(30).refine(rows => new Set(rows.map(r => r.name.toLowerCase().replace(/\s+/g, " "))).size === rows.length, "Each exercise should appear once"), archived: z.boolean().default(false) });
export const routineCreateSchema = routineDefinitionSchema.extend({ idempotencyKey: z.string().min(8).max(200) });
export const routineUpdateSchema = routineDefinitionSchema.extend({ version: z.number().int().positive() });
export const scheduleInputSchema = z.object({ routineId: z.string().uuid().nullable() });
export type RoutineExercise = z.infer<typeof routineExerciseSchema>;
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
export type Routine = RoutineDefinition & { id: string; version: number };
export type RoutineSnapshot = { routineId: string; name: string; exercises: RoutineExercise[] };
export type WeightEntry = { day: string; weightKg: number; notes: string };
export type WeightHistory = { entries: WeightEntry[]; goalKg: number | null };
export type ScheduleDay = { weekday: number; routineId: string };

export function weightTrend(entries: WeightEntry[]) {
  const ordered = [...entries].sort((a,b) => a.day.localeCompare(b.day));
  return ordered.map(entry => {
    const timestamp = Date.parse(`${entry.day}T12:00:00Z`);
    const from = new Date(timestamp - 6 * 86_400_000).toISOString().slice(0,10);
    const recent = ordered.filter(point => point.day <= entry.day && point.day >= from);
    return { ...entry, timestamp, averageKg: Math.round(recent.reduce((sum,point) => sum + point.weightKg, 0) / recent.length * 10) / 10 };
  });
}

// Small first-party catalogue. Explicit muscle choices override these exact-name hints.
export const exerciseSuggestions: { name: string; muscleGroup: MuscleGroup }[] = [
  { name: "Bench press", muscleGroup: "chest" }, { name: "Incline dumbbell press", muscleGroup: "chest" }, { name: "Push-up", muscleGroup: "chest" },
  { name: "Lat pulldown", muscleGroup: "back" }, { name: "Seated cable row", muscleGroup: "back" }, { name: "Pull-up", muscleGroup: "back" },
  { name: "Overhead press", muscleGroup: "shoulders" }, { name: "Lateral raise", muscleGroup: "shoulders" }, { name: "Biceps curl", muscleGroup: "biceps" },
  { name: "Hammer curl", muscleGroup: "biceps" }, { name: "Triceps pushdown", muscleGroup: "triceps" }, { name: "Triceps extension", muscleGroup: "triceps" },
  { name: "Squat", muscleGroup: "quads" }, { name: "Leg press", muscleGroup: "quads" }, { name: "Leg extension", muscleGroup: "quads" },
  { name: "Romanian deadlift", muscleGroup: "hamstrings" }, { name: "Leg curl", muscleGroup: "hamstrings" }, { name: "Hip thrust", muscleGroup: "glutes" },
  { name: "Calf raise", muscleGroup: "calves" }, { name: "Crunch", muscleGroup: "core" }, { name: "Hanging knee raise", muscleGroup: "core" },
];
export function muscleForExercise(name: string): MuscleGroup {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  return exerciseSuggestions.find(e => e.name.toLowerCase() === key)?.muscleGroup ?? "other";
}
export type TrainingSession = { id: string; name: string; startedAt: Date | string; finishedAt: Date | string | null; exercises: { name: string; muscleGroup: MuscleGroup | null; sets: { weightKg: number | null; reps: number }[] }[] };
export type TrainingStats = ReturnType<typeof summarizeTraining>;
export function summarizeTraining(sessions: TrainingSession[], timezone: string) {
  const muscleSets = Object.fromEntries(muscleGroups.map(m => [m, 0])) as Record<MuscleGroup, number>;
  const byDay = new Map<string, { day: string; workouts: number; sets: number; volumeKg: number }>();
  const records = new Map<string, { name: string; bestWeightKg: number | null; estimatedOneRepMax: number | null; sets: number }>();
  let minutes = 0, totalSets = 0, totalReps = 0, totalVolumeKg = 0;
  for (const session of sessions) {
    const sets = session.exercises.flatMap(e => e.sets);
    const volume = workoutVolume(sets);
    const day = getZonedCalendarDate(new Date(session.startedAt), timezone);
    const point = byDay.get(day) ?? { day, workouts: 0, sets: 0, volumeKg: 0 };
    point.workouts++; point.sets += sets.length; point.volumeKg += volume; byDay.set(day, point);
    totalSets += sets.length; totalReps += sets.reduce((sum, s) => sum + s.reps, 0); totalVolumeKg += volume;
    if (session.finishedAt) minutes += Math.max(0, (new Date(session.finishedAt).getTime() - new Date(session.startedAt).getTime()) / 60_000);
    for (const exercise of session.exercises) {
      const muscle = exercise.muscleGroup ?? muscleForExercise(exercise.name);
      muscleSets[muscle] += exercise.sets.length;
      const key = exercise.name.trim().toLowerCase().replace(/\s+/g, " ");
      const record = records.get(key) ?? { name: exercise.name, bestWeightKg: null, estimatedOneRepMax: null, sets: 0 };
      record.sets += exercise.sets.length;
      for (const set of exercise.sets) {
        if (set.weightKg !== null) record.bestWeightKg = Math.max(record.bestWeightKg ?? 0, set.weightKg);
        // High-repetition estimates are not useful strength records.
        const e1rm = set.reps <= 12 ? estimatedOneRepMax(set.weightKg, set.reps) : null;
        if (e1rm !== null) record.estimatedOneRepMax = Math.max(record.estimatedOneRepMax ?? 0, e1rm);
      }
      records.set(key, record);
    }
  }
  return { workoutCount: sessions.length, activeDays: byDay.size, totalSets, totalReps, volumeKg: Math.round(totalVolumeKg), minutes: Math.round(minutes), muscleSets, activity: [...byDay.values()].sort((a,b) => a.day.localeCompare(b.day)), records: [...records.values()].filter(r => r.sets > 0).sort((a,b) => b.sets - a.sets) };
}
