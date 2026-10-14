import { type LibraryExercise, type LibraryPage, type LibraryQuery } from "@clawfit/health-core";
import data from "./catalogue/exercises.json" with { type: "json" };

// Server-only data: imported by the repository, never the browser bundle.
export const catalogue = data as LibraryExercise[];
export const catalogueById = new Map(catalogue.map(exercise => [exercise.id, exercise]));
export const normalizeExercise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const searchText = (e: LibraryExercise) => normalizeExercise([e.name, ...e.aliases, ...e.primaryMuscles, ...e.secondaryMuscles, e.muscleGroup, e.muscleGroup === "core" ? "abs abdominals" : "", e.equipment].join(" "));
const index = new Map(catalogue.map(e => [e.id, searchText(e)]));

export function searchLibrary(query: LibraryQuery, custom: LibraryExercise[], favorites: Set<string>): LibraryPage {
  const all = [...catalogue, ...custom];
  const tokens = normalizeExercise(query.q).split(" ").filter(Boolean);
  const filtered = all.filter(e => (query.scope !== "custom" || e.custom) && (query.scope !== "favorites" || favorites.has(e.id))
    && (!query.muscle || e.muscleGroup === query.muscle) && (!query.equipment || e.equipment === query.equipment)
    && (!query.exerciseType || e.exerciseType === query.exerciseType) && (!query.difficulty || e.difficulty === query.difficulty)
    && tokens.every(token => (index.get(e.id) ?? searchText(e)).includes(token)))
    .sort((a,b) => Number(normalizeExercise(b.name) === normalizeExercise(query.q)) - Number(normalizeExercise(a.name) === normalizeExercise(query.q)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const values = (key: "equipment" | "exerciseType" | "difficulty") => [...new Set(all.map(e => e[key]).filter((v): v is string => !!v))].sort();
  return { items: filtered.slice(query.offset, query.offset + query.limit).map(e => ({ ...e, favorite: favorites.has(e.id) })), total: filtered.length, offset: query.offset, limit: query.limit, equipment: values("equipment"), exerciseTypes: values("exerciseType"), difficulties: values("difficulty") };
}

// Only exact, unambiguous names/curated aliases bridge old free-text records. Never rewrite history.
export function legacyNames(exercise: LibraryExercise): string[] {
  if (exercise.custom) return [exercise.name.toLowerCase().trim()];
  return [exercise.name, ...exercise.aliases].filter(name => catalogue.filter(e => [e.name, ...e.aliases].some(n => n.toLowerCase().trim() === name.toLowerCase().trim())).length === 1).map(n => n.toLowerCase().trim());
}
