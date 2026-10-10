import { createHash } from "node:crypto";
import { z } from "zod";
import { isValidCalendarDate } from "./calculations.js";

const nullableNutrient = z.number().finite().nonnegative().nullable();
const nutrientSchema = z.object({
  calories: nullableNutrient, calories_min: nullableNutrient, calories_max: nullableNutrient,
  protein_g: nullableNutrient, carbs_g: nullableNutrient, fat_g: nullableNutrient, fiber_g: nullableNutrient,
  confidence: z.enum(["high", "medium", "low", "unknown"]),
  uncertainty_reasons: z.array(z.string()).optional(), reasoning: z.string().optional(),
}).passthrough();
export const historicalDatasetSchema = z.object({
  meals: z.array(z.object({
    meal_id: z.string().min(1).max(120),
    actual_meal_date: z.string().refine(isValidCalendarDate),
    actual_meal_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).nullable(),
    logged_at: z.string(),
    foods: z.array(z.object({name:z.string().min(1), consumed_amounts:z.array(z.object({person:z.string()}).passthrough()).optional()}).passthrough()),
    nutrition_by_person: z.record(z.string(), nutrientSchema),
    migration_disposition: z.object({action:z.string(), duplicate_of:z.string().optional()}).passthrough().optional(),
  }).passthrough()),
  migration_release: z.object({status:z.literal("data_review_complete_with_accepted_exceptions"), timezone:z.literal("Asia/Kuala_Lumpur")}).passthrough(),
}).passthrough();
export type HistoricalDataset = z.infer<typeof historicalDatasetSchema>;
export type HistoricalMeal = HistoricalDataset["meals"][number];
export type HistoricalPerson = "Jobayer" | "Cici";
export const historicalIdentitySchema = z.object({
  Jobayer:z.object({userId:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),externalIdentifier:z.string().min(1)}).strict(),
  Cici:z.object({userId:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),externalIdentifier:z.string().min(1)}).strict(),
}).strict().refine(value => value.Jobayer.userId !== value.Cici.userId, "Two participants must have distinct users");
export type HistoricalIdentities = z.infer<typeof historicalIdentitySchema>;
export type ImportRow = {
  id:string; user_id:string; occurred_at:string; label:string;
  calories_best:number|null; calories_low:number|null; calories_high:number|null;
  protein_g:number|null; carbs_g:number|null; fat_g:number|null; fiber_g:number|null;
  confidence:"high"|"medium"|"low"; uncertainty_reasons:string[]; source:"manual";
  raw_user_text:string; idempotency_key:string;
};
export type ImportItem = {id:string; meal_id:string; name:string; portion_description:string};
export type HistoricalPayload = {rows:ImportRow[];items:ImportItem[];excluded:string[];sourceEventCount:number;sourceFingerprint:string};

export function historicalTimeKnown(raw:string|null|undefined):boolean {
  if(!raw)return true;
  try {
    const value=z.object({historicalImport:z.object({actualMealTime:z.string().nullable()})}).safeParse(JSON.parse(raw) as unknown);
    return !value.success || value.data.historicalImport.actualMealTime!==null;
  } catch { return true; }
}

const fingerprintSchema=z.string().regex(/^[0-9a-f]{64}$/);
const storedUuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const historicalPlanSchema=z.object({
  version:z.literal(1),payloadFingerprint:fingerprintSchema,identityFingerprint:fingerprintSchema,
  beforeFingerprint:fingerprintSchema,protectedFingerprint:fingerprintSchema,
  nullableSchemaUpgradeRequired:z.boolean(),
  userIds:z.array(storedUuid).length(2).refine(ids=>ids[0]!==ids[1]),
  beforeCounts:z.record(z.string(),z.number().int().nonnegative()),targetMeals:z.number().int().nonnegative(),
  existingByUserDate:z.array(z.object({userId:storedUuid,date:z.string().refine(isValidCalendarDate),meals:z.number().int().nonnegative(),overlapsImportedDate:z.boolean()}).strict()),
  targetItems:z.number().int().nonnegative(),sourceEvents:z.number().int().nonnegative(),excluded:z.array(z.string()),
  alreadyImported:z.boolean(),approvalDigest:fingerprintSchema,
}).strict();
export const historicalBackupSchema=z.object({
  version:z.literal(1),plan:historicalPlanSchema,
  before:z.object({meals:z.array(z.record(z.string(),z.unknown())),meal_items:z.array(z.record(z.string(),z.unknown())),pending_meal_estimates:z.array(z.record(z.string(),z.unknown()))}).strict(),
  afterFingerprint:fingerprintSchema,protectedFingerprint:fingerprintSchema,createdAt:z.string(),
}).strict();

export function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
export function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function deterministicId(name:string):string {
  // Fixed namespace, stable across file versions and import retries.
  const bytes=createHash("sha1").update(Buffer.from("d15b16b7f7d645e1ac07dd27346e3c35","hex")).update(name).digest().subarray(0,16);
  bytes[6]=((bytes[6] ?? 0)&15)|80; bytes[8]=((bytes[8] ?? 0)&63)|128;
  const h=bytes.toString("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function prepareHistoricalPayload(input:unknown, mapping:HistoricalIdentities):HistoricalPayload {
  const data=historicalDatasetSchema.parse(input); historicalIdentitySchema.parse(mapping);
  const ids=new Set<string>(); const rows:ImportRow[]=[]; const items:ImportItem[]=[];const excluded:string[]=[];let eventCount=0;
  for(const meal of data.meals){
    if(ids.has(meal.meal_id))throw new Error(`Duplicate source ID: ${meal.meal_id}`);ids.add(meal.meal_id);
  }
  for(const meal of data.meals){
    if(meal.migration_disposition?.action === "exclude_duplicate"){
      if(!meal.migration_disposition.duplicate_of || !ids.has(meal.migration_disposition.duplicate_of))throw new Error(`Missing duplicate survivor: ${meal.meal_id}`);
      const target=data.meals.find(x=>x.meal_id===meal.migration_disposition?.duplicate_of);
      if(target?.migration_disposition?.action==="exclude_duplicate")throw new Error("Duplicate target must be active");
      excluded.push(meal.meal_id);continue;
    }
    if(meal.migration_disposition && meal.migration_disposition.action!=="include")throw new Error(`Unsupported disposition: ${meal.meal_id}`);
    eventCount++;
    const time=meal.actual_meal_time ?? "12:00:00";
    if(!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time))throw new Error(`Invalid meal time: ${meal.meal_id}`);
    const occurredAt=new Date(`${meal.actual_meal_date}T${time}+08:00`).toISOString();
    for(const [name,n] of Object.entries(meal.nutrition_by_person)){
      const person=name==="Mahin" ? "Jobayer" : name;
      if(person!=="Jobayer" && person!=="Cici")throw new Error(`Unknown participant: ${name}`);
      if(name==="Mahin" && meal.nutrition_by_person.Jobayer)throw new Error(`Alias allocation collision: ${meal.meal_id}`);
      if(n.calories!==null && ((n.calories_min!==null && n.calories_min>n.calories)||(n.calories_max!==null && n.calories_max<n.calories)))throw new Error(`Invalid calorie range: ${meal.meal_id}`);
      if([n.calories,n.protein_g,n.carbs_g,n.fat_g].every(x=>x!==null)){
        const energy=4*n.protein_g!+4*n.carbs_g!+9*n.fat_g!;
        if(Math.abs(energy-n.calories!)>Math.max(50,.15*n.calories!))throw new Error(`Unaccepted macro energy conflict: ${meal.meal_id}`);
      }
      const key=`clawfit-whatsapp-history-v1:${meal.meal_id}:${person}`;
      const id=deterministicId(key);
      const metadata={historicalImport:{version:1,sourceMealId:meal.meal_id,sharedEventId:meal.meal_id,person,timeBasis:meal.actual_meal_time===null ? "date_only_noon_anchor" : "reviewed_time_or_chat_proxy",actualMealTime:meal.actual_meal_time,loggedAt:meal.logged_at,sourceFingerprint:digest(meal),nutritionComplete:[n.calories,n.protein_g,n.carbs_g,n.fat_g].every(x=>x!==null),sourceRecord:meal}};
      const owned=meal.foods.filter(f=>!f.consumed_amounts?.length || f.consumed_amounts.some(a=>(a.person==="Mahin"?"Jobayer":a.person)===person));
      const uncertainty=[...(n.uncertainty_reasons ?? []),"Historical reviewed import; recipe values remain estimates."];
      if(!metadata.historicalImport.nutritionComplete)uncertainty.push("Unknown historical nutrition retained as null; never zero-filled.");
      if(meal.actual_meal_time===null)uncertainty.push("Eating time unknown; noon local is a date anchor, not a claimed eating time.");
      rows.push({id,user_id:mapping[person].userId,occurred_at:occurredAt,label:(owned.map(f=>f.name).join(" + ")||`Historical ${person} meal`).slice(0,300),calories_best:n.calories===null?null:Math.round(n.calories),calories_low:n.calories_min===null?null:Math.round(n.calories_min),calories_high:n.calories_max===null?null:Math.round(n.calories_max),protein_g:n.protein_g,carbs_g:n.carbs_g,fat_g:n.fat_g,fiber_g:n.fiber_g,confidence:n.confidence==="unknown"?"low":n.confidence,uncertainty_reasons:uncertainty,source:"manual",raw_user_text:JSON.stringify(metadata),idempotency_key:key});
      owned.forEach((f,index)=>{
        const allocation=(f.consumed_amounts ?? []).filter(a=>(a.person==="Mahin"?"Jobayer":a.person)===person);
        const description=JSON.stringify({consumed:allocation,served:f.served_amount ?? null,components:f.components ?? [],quantityBasis:f.quantity_basis ?? null});
        const portion=description.length>500 ? `${description.slice(0,447)}… [full allocation in source audit metadata]` : description;
        items.push({id:deterministicId(`${key}:food:${index}`),meal_id:id,name:f.name.slice(0,200),portion_description:portion});
      });
    }
  }
  if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error("Duplicate person meal mapping");
  return {rows,items,excluded,sourceEventCount:eventCount,sourceFingerprint:digest(data)};
}
