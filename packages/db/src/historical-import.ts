import { digest, historicalBackupSchema, historicalPlanSchema, normalizeWhatsAppIdentifier, type HistoricalIdentities, type HistoricalPayload } from "@clawfit/health-core";

export type DbRow=Record<string,unknown>;
export interface ImportConnection {
  query<T extends DbRow=DbRow>(sql:string,parameters?:unknown[]):Promise<{rows:T[]}>;
}
export interface ImportDatabase extends ImportConnection {
  transaction<T>(work:(tx:ImportConnection)=>Promise<T>,readOnly?:boolean):Promise<T>;
}
export type MealSnapshot={meals:DbRow[];meal_items:DbRow[];pending_meal_estimates:DbRow[]};
export type ImportPlan={version:1;payloadFingerprint:string;identityFingerprint:string;beforeFingerprint:string;protectedFingerprint:string;nullableSchemaUpgradeRequired:boolean;userIds:string[];beforeCounts:Record<string,number>;existingByUserDate:{userId:string;date:string;meals:number;overlapsImportedDate:boolean}[];targetMeals:number;targetItems:number;sourceEvents:number;excluded:string[];alreadyImported:boolean;approvalDigest:string};
export type ImportBackup={version:1;plan:ImportPlan;before:MealSnapshot;afterFingerprint:string;protectedFingerprint:string;createdAt:string};
const protectedTables=["users","households","household_members","external_identities","user_settings","notification_preferences","food_presets","workouts","exercises","workout_sets"] as const;
const requiredNullable=["calories_best","calories_low","calories_high","protein_g","carbs_g","fat_g"];

async function verifySchema(tx:ImportConnection):Promise<boolean>{
  const columns=await tx.query<{column_name:string;is_nullable:string;data_type:string}>("SELECT column_name,is_nullable,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='meals'");
  for(const field of requiredNullable)if(!columns.rows.some(c=>c.column_name===field && c.data_type===(field.startsWith("calories_")?"integer":"real")))throw new Error(`Unexpected historical target column: meals.${field}`);
  const constraints=await tx.query<{indexdef:string}>("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='meals'");
  if(!constraints.rows.some(c=>/UNIQUE.*\(user_id, idempotency_key\)/.test(c.indexdef)))throw new Error("Missing per-user meal idempotency constraint");
  return requiredNullable.some(field=>columns.rows.find(c=>c.column_name===field)?.is_nullable!=="YES");
}
async function verifyIdentities(tx:ImportConnection,mapping:HistoricalIdentities):Promise<string>{
  const verified=[];
  for(const person of ["Jobayer","Cici"] as const){
    const m=mapping[person];const external=normalizeWhatsAppIdentifier(m.externalIdentifier);
    const result=await tx.query<{id:string;active:boolean;display_name:string}>("SELECT u.id,u.active,u.display_name FROM users u JOIN external_identities e ON e.user_id=u.id WHERE e.provider='whatsapp' AND e.external_identifier=$1 AND u.id=$2::uuid",[external,m.userId]);
    if(result.rows.length!==1 || !result.rows[0]?.active)throw new Error(`Verify existing WhatsApp ownership for ${person}; never infer from primary/partner defaults`);
    const tz=await tx.query<{timezone:string}>("SELECT timezone FROM user_settings WHERE user_id=$1::uuid",[m.userId]);
    if(tz.rows.some(x=>x.timezone!=="Asia/Kuala_Lumpur"))throw new Error(`Existing timezone mismatch for ${person}; settings are preserved`);
    verified.push({person,userId:m.userId,externalDigest:digest(external)});
  }
  const household=await tx.query("SELECT a.household_id FROM household_members a JOIN household_members b ON a.household_id=b.household_id WHERE a.user_id=$1::uuid AND b.user_id=$2::uuid",[mapping.Jobayer.userId,mapping.Cici.userId]);
  if(!household.rows.length)throw new Error("Mapped users must belong to the same existing household");
  return digest(verified);
}
async function snapshot(tx:ImportConnection,ids:string[]):Promise<MealSnapshot>{
  const [meals,items,pending]=await Promise.all([
    tx.query<{row:DbRow}>("SELECT to_jsonb(m) AS row FROM meals m WHERE user_id=ANY($1::uuid[]) ORDER BY id",[ids]),
    tx.query<{row:DbRow}>("SELECT to_jsonb(i) AS row FROM meal_items i JOIN meals m ON m.id=i.meal_id WHERE m.user_id=ANY($1::uuid[]) ORDER BY i.id",[ids]),
    tx.query<{row:DbRow}>("SELECT to_jsonb(p) AS row FROM pending_meal_estimates p WHERE user_id=ANY($1::uuid[]) ORDER BY id",[ids]),
  ]);
  return {meals:meals.rows.map(x=>x.row),meal_items:items.rows.map(x=>x.row),pending_meal_estimates:pending.rows.map(x=>x.row)};
}
async function protectedFingerprint(tx:ImportConnection):Promise<string>{
  const result:Record<string,unknown>={};
  for(const table of protectedTables){
    const key=table==="user_settings"?"user_id":"id";
    result[table]=(await tx.query<{row:DbRow}>(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${key}`)).rows.map(x=>x.row);
  }
  return digest(result);
}
function valuesEqual(actual:unknown,expected:unknown):boolean{
  if(typeof actual==="number" && typeof expected==="number")return Math.abs(actual-expected)<.001;
  return digest(actual)===digest(expected);
}
export function reconcileSnapshot(current:MealSnapshot,payload:HistoricalPayload):void{
  if(current.meals.length!==payload.rows.length || current.meal_items.length!==payload.items.length || current.pending_meal_estimates.length)throw new Error("Meal/item/draft counts do not reconcile");
  const currentMeals=new Map(current.meals.map(m=>[m.id,m]));
  for(const expected of payload.rows){
    const actual=currentMeals.get(expected.id);if(!actual)throw new Error(`Missing imported meal: ${expected.id}`);
    for(const [key,value] of Object.entries(expected)){
      const matches=key==="occurred_at" ? new Date(String(actual[key])).toISOString()===value : valuesEqual(actual[key],value);
      if(!matches)throw new Error(`Imported field differs: ${expected.id} / ${key}`);
    }
  }
  const currentItems=new Map(current.meal_items.map(i=>[i.id,i]));
  for(const expected of payload.items)if(!valuesEqual(currentItems.get(expected.id),expected))throw new Error(`Meal item differs: ${expected.id}`);
}
export async function inspectHistoricalImport(tx:ImportConnection,payload:HistoricalPayload,mapping:HistoricalIdentities):Promise<ImportPlan>{
  const nullableSchemaUpgradeRequired=await verifySchema(tx);const identityFingerprint=await verifyIdentities(tx,mapping);const userIds=[mapping.Jobayer.userId,mapping.Cici.userId];
  const current=await snapshot(tx,userIds);let alreadyImported=false;
  const localDate=(timestamp:unknown)=>new Date(new Date(String(timestamp)).getTime()+8*60*60*1000).toISOString().slice(0,10);
  const targetDates=new Set(payload.rows.map(row=>`${row.user_id}:${localDate(row.occurred_at)}`));
  const inventory=new Map<string,{userId:string;date:string;meals:number;overlapsImportedDate:boolean}>();
  for(const row of current.meals){const userId=String(row.user_id);const date=localDate(row.occurred_at);const key=`${userId}:${date}`;const group=inventory.get(key)??{userId,date,meals:0,overlapsImportedDate:targetDates.has(key)};group.meals++;inventory.set(key,group);}
  const existingByUserDate=[...inventory.values()].sort((a,b)=>`${a.userId}:${a.date}`.localeCompare(`${b.userId}:${b.date}`));
  const crossOwnerDrafts=await tx.query("SELECT p.id FROM pending_meal_estimates p JOIN meals m ON m.id=p.meal_id WHERE m.user_id=ANY($1::uuid[]) AND NOT(p.user_id=ANY($1::uuid[]))",[userIds]);
  if(crossOwnerDrafts.rows.length)throw new Error("Other-owner draft references a scoped meal; resolve ownership before replacement");
  try{reconcileSnapshot(current,payload);alreadyImported=true;}catch{/* Existing records need replacement; inspect exact counts in the plan. */}
  // A deterministic ID occupied by another owner is never overwritten.
  const conflicting=await tx.query("SELECT id FROM meals WHERE id=ANY($1::uuid[]) AND NOT(user_id=ANY($2::uuid[]))",[payload.rows.map(r=>r.id),userIds]);
  if(conflicting.rows.length)throw new Error("Imported IDs collide with records owned by another user");
  const base={version:1 as const,payloadFingerprint:digest(payload),identityFingerprint,beforeFingerprint:digest(current),protectedFingerprint:await protectedFingerprint(tx),nullableSchemaUpgradeRequired,userIds,beforeCounts:{meals:current.meals.length,meal_items:current.meal_items.length,pending_meal_estimates:current.pending_meal_estimates.length},existingByUserDate,targetMeals:payload.rows.length,targetItems:payload.items.length,sourceEvents:payload.sourceEventCount,excluded:payload.excluded,alreadyImported};
  return {...base,approvalDigest:digest(base)};
}
export async function dryRunHistoricalImport(db:ImportDatabase,payload:HistoricalPayload,mapping:HistoricalIdentities):Promise<ImportPlan>{
  return db.transaction(tx=>inspectHistoricalImport(tx,payload,mapping),true);
}
async function insertRow(tx:ImportConnection,table:"meals"|"meal_items"|"pending_meal_estimates",row:DbRow):Promise<void>{
  const keys=Object.keys(row);
  if(keys.some(k=>!/^[a-z_]+$/.test(k)))throw new Error("Invalid backup column name");
  const jsonFields=new Set(["uncertainty_reasons","items"]);
  const values=keys.map(k=>jsonFields.has(k)?JSON.stringify(row[k]):row[k]);
  await tx.query(`INSERT INTO ${table} (${keys.map(k=>`"${k}"`).join(",")}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(",")})`,values);
}
export async function executeHistoricalImport(db:ImportDatabase,payload:HistoricalPayload,mapping:HistoricalIdentities,approved:ImportPlan,writeBackup:(backup:ImportBackup)=>Promise<void>):Promise<{status:"imported"|"already_imported";meals:number;items:number}>{
  historicalPlanSchema.parse(approved);
  const {approvalDigest,...planBody}=approved;
  if(digest(planBody)!==approvalDigest)throw new Error("Dry-run receipt digest does not verify");
  return db.transaction(async tx=>{
    await tx.query("LOCK TABLE meals,meal_items,pending_meal_estimates IN SHARE ROW EXCLUSIVE MODE");
    const currentPlan=await inspectHistoricalImport(tx,payload,mapping);
    if(currentPlan.nullableSchemaUpgradeRequired)throw new Error("Deploy the approved nullable-nutrition schema/application change before importing; no meal writes occurred");
    if(currentPlan.alreadyImported){
      if(currentPlan.payloadFingerprint!==approved.payloadFingerprint || currentPlan.identityFingerprint!==approved.identityFingerprint)throw new Error("Retry does not match approved data and ownership");
      return {status:"already_imported",meals:payload.rows.length,items:payload.items.length};
    }
    // A preflight on the old schema may explicitly approve this one predicted upgrade.
    const expectedDigest=digest({...planBody,nullableSchemaUpgradeRequired:false});
    if(currentPlan.approvalDigest!==expectedDigest)throw new Error("Data, identity, settings or existing meal inventory changed since the approved dry run; rerun it before executing");
    const before=await snapshot(tx,currentPlan.userIds);
    await tx.query("DELETE FROM pending_meal_estimates WHERE user_id=ANY($1::uuid[])",[currentPlan.userIds]);
    await tx.query("DELETE FROM meals WHERE user_id=ANY($1::uuid[])",[currentPlan.userIds]);
    for(const row of payload.rows)await insertRow(tx,"meals",row);
    for(const item of payload.items)await insertRow(tx,"meal_items",item);
    const after=await snapshot(tx,currentPlan.userIds);reconcileSnapshot(after,payload);
    if(await protectedFingerprint(tx)!==currentPlan.protectedFingerprint)throw new Error("Protected user/settings/workout records changed");
    // Must complete durable local write before commit; write failure rolls back replacement.
    await writeBackup({version:1,plan:approved,before,afterFingerprint:digest(after),protectedFingerprint:currentPlan.protectedFingerprint,createdAt:new Date().toISOString()});
    return {status:"imported",meals:payload.rows.length,items:payload.items.length};
  });
}
export async function rollbackHistoricalImport(db:ImportDatabase,backup:ImportBackup):Promise<void>{
  historicalBackupSchema.parse(backup);
  const {approvalDigest,...planBody}=backup.plan;
  if(digest(planBody)!==approvalDigest || digest(backup.before)!==backup.plan.beforeFingerprint)throw new Error("Recovery backup integrity check failed");
  await db.transaction(async tx=>{
    await tx.query("LOCK TABLE meals,meal_items,pending_meal_estimates IN SHARE ROW EXCLUSIVE MODE");
    const current=await snapshot(tx,backup.plan.userIds);
    if(digest(current)!==backup.afterFingerprint)throw new Error("Meals changed after import; automatic rollback refused to avoid overwriting later logs");
    await tx.query("DELETE FROM pending_meal_estimates WHERE user_id=ANY($1::uuid[])",[backup.plan.userIds]);
    await tx.query("DELETE FROM meals WHERE user_id=ANY($1::uuid[])",[backup.plan.userIds]);
    for(const row of backup.before.meals)await insertRow(tx,"meals",row);
    for(const row of backup.before.meal_items)await insertRow(tx,"meal_items",row);
    for(const row of backup.before.pending_meal_estimates)await insertRow(tx,"pending_meal_estimates",row);
    if(digest(await snapshot(tx,backup.plan.userIds))!==digest(backup.before))throw new Error("Recovery snapshot did not reconcile");
  });
}
