// Offline import of a reviewed text snapshot only. Never downloads media.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/import-exercise-text.mjs /path/to/reviewed-exercises.json");
const raw = await readFile(input);
const expectedHash = "656634224b8977b99a6d765470ee123260d4979715eaa4e7c0b7c8bb0d79f93d";
if (createHash("sha256").update(raw).digest("hex") !== expectedHash) throw new Error("Unreviewed dataset snapshot: review licensing and IDs before changing the import hash");
const inputSchema = z.array(z.object({ id: z.string().regex(/^\d{4}$/), name: z.string().min(1).max(160), target: z.string(), secondary_muscles: z.array(z.string()), equipment: z.string(), body_part: z.string(), instruction_steps: z.object({ en: z.array(z.string().min(1)).min(1) }) }));
const rows = inputSchema.parse(JSON.parse(raw));
const manifest = JSON.parse(await readFile(new URL("../docs/licenses/exercise-media.json",import.meta.url),"utf8"));
const muscleMap = { abs:"core",delts:"shoulders",lats:"back",pectorals:"chest",traps:"back","upper back":"back",spine:"back","levator scapulae":"back","serratus anterior":"core" };
const aliases = {
 "0025":["bench press","flat bench press"],"0027":["barbell row","bent-over row"],"0031":["barbell biceps curl"],"0043":["back squat","barbell squat"],"0042":["front squat"],"0032":["deadlift"],"0095":["barbell shrugs"],"0662":["pushup","push up","press up"],"0652":["pullup","pull up"],"1326":["chin up"],"0861":["seated cable row","low row"],"0313":["hammer curl"],"0405":["dumbbell shoulder press"],"0334":["lateral raise"],"0599":["seated leg curl"],"0586":["lying leg curl"],
};
const output = rows.map(e=>({ id:`edb:${e.id}`,name:e.name[0].toUpperCase()+e.name.slice(1),aliases:aliases[e.id]??[],primaryMuscles:[e.target],secondaryMuscles:e.secondary_muscles,muscleGroup:muscleMap[e.target]??(["biceps","triceps","calves","glutes","hamstrings","quads"].includes(e.target)?e.target:"other"),equipment:e.equipment,exerciseType:e.body_part==="cardio"?"cardio":e.name.includes("stretch")?"stretching":null,difficulty:null,instructions:e.instruction_steps.en,media:manifest.filter(m=>m.exerciseId===`edb:${e.id}`).map(({kind,src,author,license,licenseUrl,sourceUrl})=>({kind,src,author,license,licenseUrl,sourceUrl})),source:"exercises-dataset",custom:false }));
if(new Set(output.map(e=>e.id)).size!==output.length)throw new Error("Duplicate catalogue IDs");
await writeFile(new URL("../packages/db/src/catalogue/exercises.json",import.meta.url),JSON.stringify(output)+"\n");
console.log(`Imported ${output.length} text records; reused only the reviewed media manifest.`);
