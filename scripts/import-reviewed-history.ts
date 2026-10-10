import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { digest, historicalBackupSchema, historicalIdentitySchema, historicalPlanSchema, prepareHistoricalPayload, type HistoricalIdentities } from "../packages/health-core/src/index.js";
import { dryRunHistoricalImport, executeHistoricalImport, rollbackHistoricalImport, type DbRow, type ImportBackup, type ImportDatabase, type ImportPlan } from "../packages/db/src/historical-import.js";
import { createDatabase } from "../packages/db/src/client.js";
import { loadClawFitEnv } from "./load-env.js";

const {values}=parseArgs({options:{
  data:{type:"string"},identities:{type:"string"},out:{type:"string"},plan:{type:"string"},backup:{type:"string"},
  "approve-plan":{type:"string"},execute:{type:"boolean",default:false},rollback:{type:"boolean",default:false},simulate:{type:"boolean",default:false},
},allowPositionals:false});
if(values.execute && values.rollback)throw new Error("Choose execution or recovery, never both");
if(values.simulate && (values.execute||values.rollback))throw new Error("Simulation performs its own local transaction tests; do not supply execution flags");

async function durableJson(path:string,value:unknown):Promise<void>{
  const file=await open(resolve(path),"wx",0o600);
  try{await file.writeFile(JSON.stringify(value,null,2)+"\n");await file.sync();}finally{await file.close();}
  const folder=await open(dirname(resolve(path)),"r");try{await folder.sync();}finally{await folder.close();}
}
async function saveReport(value:unknown):Promise<void>{
  if(!values.out)throw new Error("--out is required; report contains the concrete approval digest");
  await writeFile(resolve(values.out),JSON.stringify(value,null,2)+"\n",{mode:0o600});
}
async function loadData(){
  if(!values.data)throw new Error("--data is required");
  const bytes=await readFile(resolve(values.data));const data:unknown=JSON.parse(bytes.toString("utf8"));
  return {data,sha256:createHash("sha256").update(bytes).digest("hex")};
}
const simulationMapping:HistoricalIdentities={
  Jobayer:{userId:"00000000-0000-0000-0000-000000000002",externalIdentifier:"+60000000001"},
  Cici:{userId:"00000000-0000-0000-0000-000000000003",externalIdentifier:"+60000000002"},
};

async function simulation():Promise<void>{
  const input=await loadData();const payload=prepareHistoricalPayload(input.data,simulationMapping);const pg=new PGlite();
  const db:ImportDatabase={query:(sql,params)=>pg.query(sql,params),transaction:(fn,readOnly)=>pg.transaction(async tx=>{if(readOnly)await tx.query("SET TRANSACTION READ ONLY");return fn(tx);})};
  try{
    const folder=resolve("packages/db/drizzle");for(const name of (await readdir(folder)).filter(n=>n.endsWith(".sql")).sort())await pg.exec((await readFile(resolve(folder,name),"utf8")).replaceAll("--> statement-breakpoint",""));
    for(const person of ["Jobayer","Cici"] as const){const identity=simulationMapping[person];await db.query("INSERT INTO external_identities(user_id,provider,external_identifier) VALUES($1,'whatsapp',$2)",[identity.userId,identity.externalIdentifier]);}
    const protectedBefore=(await db.query("SELECT to_jsonb(u) AS value FROM users u ORDER BY id")).rows;
    const plan=await dryRunHistoricalImport(db,payload,simulationMapping);let backup:ImportBackup|undefined;
    const first=await executeHistoricalImport(db,payload,simulationMapping,plan,async value=>{backup=value;});
    const retry=await executeHistoricalImport(db,payload,simulationMapping,plan,async()=>{throw new Error("Retry must not create another backup");});
    if(!backup)throw new Error("Simulation failed to capture recovery snapshot");
    await rollbackHistoricalImport(db,backup);const recovered=(await db.query("SELECT count(*)::int AS count FROM meals")).rows[0]?.count;
    if(recovered!==0)throw new Error("Simulation recovery did not restore the original empty meal state");
    const final=await executeHistoricalImport(db,payload,simulationMapping,plan,async()=>{});
    if(digest(protectedBefore)!==digest((await db.query("SELECT to_jsonb(u) AS value FROM users u ORDER BY id")).rows))throw new Error("Simulation modified users");
    const totals=await db.query(`SELECT user_id,to_char(occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM-DD') AS day,count(*)::int AS meal_count,
      CASE WHEN count(*)=count(calories_best) THEN sum(calories_best) ELSE NULL END AS calories,
      sum(calories_best) AS known_calories_subtotal,
      CASE WHEN count(*)=count(protein_g) THEN sum(protein_g) ELSE NULL END AS protein_g,
      CASE WHEN count(*)=count(carbs_g) THEN sum(carbs_g) ELSE NULL END AS carbs_g,
      CASE WHEN count(*)=count(fat_g) THEN sum(fat_g) ELSE NULL END AS fat_g
      FROM meals GROUP BY user_id,day ORDER BY user_id,day`);
    await saveReport({status:"local_schema_simulation_passed",productionDatabaseAccessed:false,liveIdentityMappingVerified:false,sourceSha256:input.sha256,sourceEvents:payload.sourceEventCount,personOwnedMeals:payload.rows.length,foodItems:payload.items.length,excludedDuplicates:payload.excluded,unknownCalorieRows:payload.rows.filter(r=>r.calories_best===null).length,unknownMacroRows:payload.rows.filter(r=>r.protein_g===null||r.carbs_g===null||r.fat_g===null).length,first,retry,rollbackVerified:true,final,protectedUsersUnchanged:true,dailyTotals:totals.rows});
    console.log(`Local simulation passed: ${payload.rows.length} person meals, retry inserted none, recovery verified. Production untouched.`);
  }finally{await pg.close();}
}

async function live():Promise<void>{
  loadClawFitEnv();const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error("DATABASE_URL is required for live read-only preflight; configure it privately in the runner environment");
  const client=createDatabase(databaseUrl);const sql=client.db.$client;
  const db:ImportDatabase={
    async query<T extends DbRow>(text:string,params:unknown[]=[]){const rows=await sql.unsafe(text,params as never[]);return {rows:rows as unknown as T[]};},
    async transaction(fn,readOnly=false){const result=await sql.begin(readOnly ? "isolation level serializable read only" : "isolation level serializable",async tx=>({value:await fn({async query<T extends DbRow>(text:string,params:unknown[]=[]){const rows=await tx.unsafe(text,params as never[]);return {rows:rows as unknown as T[]};}})}));return result.value;},
  };
  try{
    if(values.rollback){
      if(!values.backup||!values["approve-plan"])throw new Error("Recovery requires --backup and --approve-plan digest after explicit authorization");
      const backup=historicalBackupSchema.parse(JSON.parse(await readFile(resolve(values.backup),"utf8")) as unknown);
      if(backup.version!==1 || !backup.plan || !backup.before || !Array.isArray(backup.plan.userIds)||backup.plan.userIds.length!==2 || backup.plan.approvalDigest!==values["approve-plan"])throw new Error("Invalid or unapproved recovery backup");
      await rollbackHistoricalImport(db,backup);await saveReport({status:"recovered",approvalDigest:backup.plan.approvalDigest});return;
    }
    if(!values.identities)throw new Error("--identities is required; map both real users by UUID and existing WhatsApp identity");
    const mapping=historicalIdentitySchema.parse(JSON.parse(await readFile(resolve(values.identities),"utf8")) as unknown);const input=await loadData();const payload=prepareHistoricalPayload(input.data,mapping);
    if(values.execute){
      if(!values.plan||!values.backup||!values["approve-plan"])throw new Error("Execution requires --plan, --backup and --approve-plan after an authorized live dry run");
      const receipt=JSON.parse(await readFile(resolve(values.plan),"utf8")) as {plan:ImportPlan;sourceSha256:string};
      historicalPlanSchema.parse(receipt.plan);
      if(receipt.sourceSha256!==input.sha256 || receipt.plan?.approvalDigest!==values["approve-plan"])throw new Error("Execution does not match approved dry-run receipt / source bytes");
      await mkdir(dirname(resolve(values.backup)),{recursive:true,mode:0o700});
      const result=await executeHistoricalImport(db,payload,mapping,receipt.plan,backup=>durableJson(values.backup!,backup));await saveReport({status:result.status,sourceSha256:input.sha256,result,approvalDigest:receipt.plan.approvalDigest});
    }else{
      const plan=await dryRunHistoricalImport(db,payload,mapping);await saveReport({status:"live_read_only_preflight_passed",sourceSha256:input.sha256,plan,scope:"Replace all existing meals, child items and pending meal drafts for precisely these two verified users; retain users/settings/identities/workouts/presets and other owners"});
      console.log(`Read-only preflight passed. Existing meals: ${plan.beforeCounts.meals}; target: ${plan.targetMeals}; approval digest: ${plan.approvalDigest}`);
    }
  }finally{await client.close();}
}

try{if(values.simulate)await simulation();else await live();}catch(error){console.error(error instanceof Error ? error.message : "Historical import failed");process.exitCode=1;}
