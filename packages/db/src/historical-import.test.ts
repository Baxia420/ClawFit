import { readFile,readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { digest,prepareHistoricalPayload,type HistoricalIdentities } from "@clawfit/health-core";
import { dryRunHistoricalImport,executeHistoricalImport,rollbackHistoricalImport,type ImportBackup,type ImportDatabase } from "./historical-import.js";
import { HealthRepository } from "./repository.js";
import type { HealthDatabase } from "./client.js";
import * as schema from "./schema.js";

const ids:HistoricalIdentities={Jobayer:{userId:"00000000-0000-0000-0000-000000000002",externalIdentifier:"+60000000001"},Cici:{userId:"00000000-0000-0000-0000-000000000003",externalIdentifier:"+60000000002"}};
const complete={calories:500,calories_min:400,calories_max:600,protein_g:30,carbs_g:50,fat_g:20,fiber_g:3,confidence:"low"};
const unknown={calories:1000,calories_min:800,calories_max:1200,protein_g:null,carbs_g:null,fat_g:null,fiber_g:null,confidence:"low"};
function dataset(){return {migration_release:{status:"data_review_complete_with_accepted_exceptions",timezone:"Asia/Kuala_Lumpur"},meals:[
  {meal_id:"shared_one",logged_at:"2026-09-12T09:00:00",actual_meal_date:"2026-09-12",actual_meal_time:"09:00:00",foods:[{name:"Chicken rice",consumed_amounts:[{person:"Jobayer",estimated_grams:200},{person:"Cici",estimated_grams:250}]}],nutrition_by_person:{Jobayer:complete,Cici:complete},shared:true,human_review:{status:"corrected"}},
  {meal_id:"allowance",logged_at:"2026-09-12T23:00:00",actual_meal_date:"2026-09-11",actual_meal_time:null,foods:[],nutrition_by_person:{Jobayer:unknown}},
  {meal_id:"duplicate",logged_at:"2026-09-12T09:01:00",actual_meal_date:"2026-09-12",actual_meal_time:"09:01:00",foods:[],nutrition_by_person:{},migration_disposition:{action:"exclude_duplicate",duplicate_of:"shared_one"}},
]};}

describe("reviewed historical import",()=>{
  let pg:PGlite;let db:ImportDatabase;
  beforeEach(async()=>{
    pg=new PGlite();db={query:(text,params)=>pg.query(text,params),transaction:(fn,readOnly)=>pg.transaction(async tx=>{if(readOnly)await tx.query("SET TRANSACTION READ ONLY");return fn(tx);})};
    const folder=new URL("../drizzle/",import.meta.url);
    for(const file of (await readdir(folder)).filter(n=>n.endsWith(".sql")).sort())await pg.exec((await readFile(new URL(file,folder),"utf8")).replaceAll("--> statement-breakpoint",""));
    for(const person of ["Jobayer","Cici"] as const)await db.query("INSERT INTO external_identities(user_id,provider,external_identifier) VALUES($1,'whatsapp',$2)",[ids[person].userId,ids[person].externalIdentifier]);
    await db.query("INSERT INTO meals(id,user_id,label,calories_best,calories_low,calories_high,protein_g,carbs_g,fat_g,confidence,source,occurred_at,idempotency_key) VALUES('11111111-1111-4111-a111-111111111111',$1,'Old meal',100,80,120,1,20,2,'low','text','2026-08-01T01:00:00Z','old-meal')",[ids.Jobayer.userId]);
    await db.query("INSERT INTO meal_items(meal_id,name,portion_description) VALUES('11111111-1111-4111-a111-111111111111','Old item','one')");
    await db.query("INSERT INTO pending_meal_estimates(user_id,label,calories_best,calories_low,calories_high,protein_g,carbs_g,fat_g,confidence,source,occurred_at,idempotency_key,scope_key,expires_at) VALUES($1,'Old draft',100,80,120,1,20,2,'low','text',now(),'old-draft','test',now()+interval '1 day')",[ids.Jobayer.userId]);
    await db.query("INSERT INTO workouts(user_id,name,started_at,idempotency_key) VALUES($1,'Keep workout',now(),'keep-workout')",[ids.Jobayer.userId]);
    await db.query("INSERT INTO users(id,display_name) VALUES('99999999-9999-4999-a999-999999999999','Other user')");
    await db.query("INSERT INTO meals(user_id,label,calories_best,calories_low,calories_high,protein_g,carbs_g,fat_g,confidence,source,occurred_at,idempotency_key) VALUES('99999999-9999-4999-a999-999999999999','Other meal',200,180,220,10,20,9,'low','text',now(),'other-meal')");
  });
  afterEach(async()=>pg.close());
  async function state(){return (await db.query("SELECT * FROM (SELECT 'meal' AS kind,to_jsonb(m) AS data FROM meals m UNION ALL SELECT 'item',to_jsonb(i) FROM meal_items i UNION ALL SELECT 'draft',to_jsonb(p) FROM pending_meal_estimates p) combined ORDER BY kind,data::text")).rows;}
  it("preflights without writes; replaces only mapped meals; retries without duplicates and restores the exact backup",async()=>{
    const payload=prepareHistoricalPayload(dataset(),ids);const before=await state();const plan=await dryRunHistoricalImport(db,payload,ids);
    expect(await state()).toEqual(before);expect(plan.beforeCounts).toEqual({meals:1,meal_items:1,pending_meal_estimates:1});expect(payload.rows).toHaveLength(3);
    let backup:ImportBackup|undefined;const first=await executeHistoricalImport(db,payload,ids,plan,async b=>{backup=b;});expect(first.status).toBe("imported");
    expect((await db.query("SELECT label FROM meals WHERE user_id='99999999-9999-4999-a999-999999999999'")).rows).toEqual([{label:"Other meal"}]);
    expect((await db.query("SELECT name FROM workouts")).rows).toEqual([{name:"Keep workout"}]);
    const repeat=await executeHistoricalImport(db,payload,ids,plan,async()=>{throw new Error("Unexpected backup");});expect(repeat.status).toBe("already_imported");
    const imported=(await db.query("SELECT raw_user_text,protein_g,occurred_at FROM meals WHERE idempotency_key LIKE '%allowance%'")).rows[0]!;
    expect(imported.protein_g).toBeNull();expect(new Date(String(imported.occurred_at)).toISOString()).toBe("2026-09-11T04:00:00.000Z");
    expect(JSON.parse(String(imported.raw_user_text)).historicalImport.actualMealTime).toBeNull();
    await rollbackHistoricalImport(db,backup!);expect(digest(await state())).toBe(digest(before));
  });
  it("rolls back replacement if durable backup creation fails",async()=>{
    const payload=prepareHistoricalPayload(dataset(),ids);const before=await state();const plan=await dryRunHistoricalImport(db,payload,ids);
    await expect(executeHistoricalImport(db,payload,ids,plan,async()=>{throw new Error("Disk full");})).rejects.toThrow("Disk full");expect(await state()).toEqual(before);
  });
  it("preflights the current NOT NULL schema without writes and permits only its explicitly predicted nullable upgrade",async()=>{
    await db.query("ALTER TABLE meals ALTER COLUMN protein_g SET NOT NULL");
    const payload=prepareHistoricalPayload(dataset(),ids);const plan=await dryRunHistoricalImport(db,payload,ids);
    expect(plan.nullableSchemaUpgradeRequired).toBe(true);
    await expect(executeHistoricalImport(db,payload,ids,plan,async()=>{})).rejects.toThrow("approved nullable");
    await db.query("ALTER TABLE meals ALTER COLUMN protein_g DROP NOT NULL");
    await expect(executeHistoricalImport(db,payload,ids,plan,async()=>{})).resolves.toMatchObject({status:"imported"});
  });
  it("refuses changed inventory and wrong participant identity",async()=>{
    const payload=prepareHistoricalPayload(dataset(),ids);const plan=await dryRunHistoricalImport(db,payload,ids);
    await db.query("UPDATE meals SET calories_best=105 WHERE id='11111111-1111-4111-a111-111111111111'");
    await expect(executeHistoricalImport(db,payload,ids,plan,async()=>{})).rejects.toThrow("changed since");
    const swapped={Jobayer:ids.Cici,Cici:ids.Jobayer};
    // Swapping UUIDs alone must fail the existing external identity evidence.
    await expect(dryRunHistoricalImport(db,payload,{Jobayer:{...swapped.Jobayer,externalIdentifier:ids.Jobayer.externalIdentifier},Cici:ids.Cici})).rejects.toThrow("ownership");
  });
  it("refuses recovery after later meal edits and propagates unknown macros through repository totals",async()=>{
    const payload=prepareHistoricalPayload(dataset(),ids);const plan=await dryRunHistoricalImport(db,payload,ids);let backup:ImportBackup|undefined;
    await executeHistoricalImport(db,payload,ids,plan,async b=>{backup=b;});
    const repository=new HealthRepository(drizzle(pg,{schema}) as unknown as HealthDatabase);
    const daily=await repository.dailyNutrition(ids.Jobayer.userId,new Date("2026-09-11T00:00:00Z"),new Date("2026-09-12T00:00:00Z"));
    expect(daily.totals.caloriesBest).toBe(1000);expect(daily.totals.proteinG).toBeNull();
    const trend=await repository.nutritionTrend(ids.Jobayer.userId,new Date("2026-09-10T00:00:00Z"),new Date("2026-09-13T00:00:00Z"),"Asia/Kuala_Lumpur");expect(trend[0]?.protein_g).toBeNull();
    await db.query("UPDATE meals SET label='Edited after import' WHERE id=$1",[payload.rows[0]!.id]);
    await expect(rollbackHistoricalImport(db,backup!)).rejects.toThrow("changed after import");
  });
});
