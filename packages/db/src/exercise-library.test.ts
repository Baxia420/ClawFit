import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { customExerciseSchema, libraryQuerySchema } from "@clawfit/health-core";
import { catalogue, searchLibrary } from "./catalogue.js";
import { HealthRepository, DEFAULT_PRIMARY_USER_ID as owner, DEFAULT_PARTNER_USER_ID as partner } from "./repository.js";
import type { HealthDatabase } from "./client.js";
import * as schema from "./schema.js";
const custom = customExerciseSchema.parse({ name: "My press", instructions: ["Sit upright.", "Press and lower with control."], muscleGroup: "shoulders", primaryMuscles: ["delts"], equipment: "dumbbell" });

describe("exercise library", () => {
  let pg: PGlite, repository: HealthRepository;
  beforeAll(async () => {
    pg = new PGlite();
    const files = (await readdir(new URL("../drizzle", import.meta.url))).filter(f => f.endsWith(".sql")).sort();
    for (const file of files.filter(f => !f.startsWith("0008"))) await pg.exec((await readFile(new URL(`../drizzle/${file}`,import.meta.url),"utf8")).replaceAll("--> statement-breakpoint",""));
    // A legacy record exists before migration, and must retain its free text and sets.
    await pg.exec(`INSERT INTO workouts(id,user_id,name,status,started_at,idempotency_key) VALUES ('11111111-1111-4111-8111-111111111111','${owner}','Legacy','finished',now(),'legacy-library-workout');
      INSERT INTO exercises(id,workout_id,name,normalized_name,position) VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Bench press','bench press',0);
      INSERT INTO workout_sets(exercise_id,set_number,weight_kg,reps,occurred_at,idempotency_key) VALUES ('22222222-2222-4222-8222-222222222222',1,70,8,now(),'legacy-library-set');`);
    repository = new HealthRepository(drizzle(pg,{schema}) as unknown as HealthDatabase);
    await expect(repository.checkReady()).rejects.toThrow();
    for (const file of files.filter(f=>f.startsWith("0008"))) await pg.exec((await readFile(new URL(`../drizzle/${file}`,import.meta.url),"utf8")).replaceAll("--> statement-breakpoint",""));
  });
  afterAll(async()=>{await pg?.close();});
  it("searches aliases and muscles, filters and paginates deterministically without an external API",()=>{
    expect(catalogue).toHaveLength(1324);
    expect(new Set(catalogue.map(e=>e.id)).size).toBe(1324);
    const query=(input:object)=>searchLibrary(libraryQuerySchema.parse(input),[],new Set());
    expect(query({q:"flat bench press"}).items.some(e=>e.id==="edb:0025")).toBe(true);
    expect(query({q:"pectorals",equipment:"barbell",muscle:"chest"}).items.every(e=>e.equipment==="barbell"&&e.muscleGroup==="chest")).toBe(true);
    expect(query({limit:5,offset:5}).items).toEqual(query({limit:10}).items.slice(5));
    expect(query({q:"zzzyyyxxx"}).total).toBe(0);
    expect(catalogue.every(e=>e.instructions.length>0 && !e.media.some(m=>/gymvisual|opengym/.test(m.src)))).toBe(true);
  });
  it("preserves legacy records and includes exact unambiguous aliases only in the owner's history",async()=>{
    expect(await repository.checkReady()).toBe(true);
    const rows=await repository.libraryHistory(owner,"edb:0025");
    expect(rows).toHaveLength(1);expect(rows[0]?.weightKg).toBe(70);
    expect(await repository.libraryHistory(partner,"edb:0025")).toEqual([]);
    expect((await repository.getWorkout(owner,"11111111-1111-4111-8111-111111111111")).exercises[0]).toMatchObject({name:"Bench press",libraryId:null});
  });
  it("isolates favorites and custom exercises and makes retries idempotent",async()=>{
    await repository.favoriteExercise(owner,"edb:0025",true);await repository.favoriteExercise(owner,"edb:0025",true);
    expect((await repository.librarySearch(owner,libraryQuerySchema.parse({scope:"favorites"}))).total).toBe(1);
    expect((await repository.librarySearch(partner,libraryQuerySchema.parse({scope:"favorites"}))).total).toBe(0);
    const a=await repository.createCustomExercise(owner,{...custom,idempotencyKey:"custom-library-one"});
    expect((await repository.createCustomExercise(owner,{...custom,idempotencyKey:"custom-library-one"})).id).toBe(a.id);
    await expect(repository.libraryExercise(partner,a.id)).rejects.toThrow("not found");
    await expect(repository.favoriteExercise(partner,a.id,true)).rejects.toThrow("not found");
    await expect(repository.updateCustomExercise(partner,a.id,{...custom,version:1})).rejects.toThrow("not found");
    await repository.favoriteExercise(owner,"edb:0025",false);
    expect((await repository.librarySearch(owner,libraryQuerySchema.parse({scope:"favorites"}))).total).toBe(0);
    await expect(repository.updateCustomExercise(owner,"edb:0025",{...custom,version:1})).rejects.toThrow("read-only");
  });
  it("keeps stable identity across custom renames and preserves routine/workout snapshots",async()=>{
    const exercise=await repository.createCustomExercise(owner,{...custom,idempotencyKey:"custom-library-two"});
    const definition={name:"Upper",archived:false,exercises:[{name:exercise.name,libraryId:exercise.id,muscleGroup:custom.muscleGroup,sets:4,reps:10,restSeconds:120}]};
    await expect(repository.saveRoutine(partner,{...definition,idempotencyKey:"stolen-custom-routine"})).rejects.toThrow("not found");
    const routine=await repository.saveRoutine(owner,{...definition,idempotencyKey:"library-routine-one"});
    const workout=await repository.startWorkout(owner,{name:"Upper",routineId:routine.id,idempotencyKey:"library-workout-one"});
    await repository.addWorkoutSet(owner,workout.workout.id,{exerciseName:exercise.name,libraryId:exercise.id,weightKg:20,reps:10,idempotencyKey:"library-set-one"});
    await repository.updateCustomExercise(owner,exercise.id,{...custom,name:"Renamed press",version:1});
    await expect(repository.updateCustomExercise(owner,exercise.id,{...custom,version:1})).rejects.toThrow("another device");
    expect(await repository.libraryHistory(owner,exercise.id)).toHaveLength(1);
    await repository.updateRoutine(owner,routine.id,{...definition,version:1,exercises:[{...definition.exercises[0]!,libraryId:"edb:0025",name:"Barbell bench press",muscleGroup:"chest"}]});
    const snapshot=await repository.getWorkout(owner,workout.workout.id);
    expect(snapshot.workout.routineSnapshot?.exercises[0]).toMatchObject({libraryId:exercise.id,name:exercise.name,sets:4,reps:10,restSeconds:120});
    expect(snapshot.setCount).toBe(1);
    await expect(repository.addWorkoutSet(partner,workout.workout.id,{exerciseName:exercise.name,libraryId:exercise.id,weightKg:20,reps:10,idempotencyKey:"stolen-custom-set"})).rejects.toThrow();
  });
});
