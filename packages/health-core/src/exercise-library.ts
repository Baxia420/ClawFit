import { z } from "zod";
import { muscleGroupSchema, type MuscleGroup } from "./training.js";

export const libraryIdSchema = z.string().regex(/^(edb:\d{4}|custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
export function youtubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : ["youtube.com", "www.youtube.com"].includes(url.hostname) && url.pathname === "/watch" ? url.searchParams.get("v") : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
export const customExerciseSchema = z.object({
  name: z.string().trim().min(1).max(160),
  instructions: z.array(z.string().trim().min(1).max(1500)).min(1).max(30),
  muscleGroup: muscleGroupSchema,
  primaryMuscles: z.array(z.string().trim().min(1).max(60)).min(1).max(8),
  secondaryMuscles: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  equipment: z.string().trim().min(1).max(80),
  exerciseType: z.enum(["strength", "cardio", "stretching", "balance"]).nullable().default(null),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).nullable().default(null),
  mediaUrl: z.string().max(300).refine(value => value === "" || youtubeVideoId(value) !== null, "Use an HTTPS YouTube watch or youtu.be link").default(""),
});
export const customExerciseCreateSchema = customExerciseSchema.extend({ idempotencyKey: z.string().min(8).max(200) });
export const customExerciseUpdateSchema = customExerciseSchema.extend({ version: z.number().int().positive() });
export const libraryQuerySchema = z.object({
  q: z.string().trim().max(160).default(""), muscle: muscleGroupSchema.optional(),
  equipment: z.string().max(80).optional(), exerciseType: z.string().max(30).optional(), difficulty: z.string().max(30).optional(),
  scope: z.enum(["all", "favorites", "custom"]).default("all"),
  offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type LibraryQuery = z.infer<typeof libraryQuerySchema>;
export type CustomExerciseInput = z.infer<typeof customExerciseSchema>;
export type ExerciseMedia = { kind: "image"; src: string; author: string; license: string; licenseUrl: string; sourceUrl: string };
export type LibraryExercise = {
  id: string; name: string; aliases: string[]; muscleGroup: MuscleGroup; primaryMuscles: string[]; secondaryMuscles: string[];
  equipment: string; exerciseType: string | null; difficulty: string | null; instructions: string[]; media: ExerciseMedia[];
  source: string; custom: boolean; favorite?: boolean; version?: number; mediaUrl?: string;
};
export type LibraryPage = { items: LibraryExercise[]; total: number; offset: number; limit: number; equipment: string[]; exerciseTypes: string[]; difficulties: string[] };
export type ExerciseHistorySet = { id: string; occurredAt: string; weightKg: number | null; reps: number; estimatedOneRepMax: number | null; workoutName: string };
