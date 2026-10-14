// Run after pnpm build. Uses isolated local services and synthetic sessions only.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { encode } from "../apps/web/node_modules/next-auth/jwt.js";
import assert from "node:assert/strict";
const root=resolve(import.meta.dirname,"..");
const env={...process.env,AUTH_SECRET:"local-browser-session-secret-at-least-32-chars",WEB_ASSERTION_SIGNING_SECRET:"local-browser-assertion-secret-at-least-32-chars",HEALTH_API_URL:"http://127.0.0.1:4009",HEALTH_API_WEB_TOKEN:"local-browser-test-machine-token",AUTH_URL:"http://127.0.0.1:3009",AUTH_GOOGLE_ID:"",AUTH_GOOGLE_SECRET:"",GOOGLE_CLIENT_ID:"",GOOGLE_CLIENT_SECRET:""};
const children=[];
function start(args,cwd=root){const child=spawn(process.execPath,args,{cwd,env,stdio:["ignore","pipe","pipe"]});children.push(child);let output="";child.stdout.on("data",d=>output+=d);child.stderr.on("data",d=>output+=d);return {child,output:()=>output};}
async function ready(url,service){for(let i=0;i<30;i++){if(service.child.exitCode!==null)throw new Error(service.output());try{if((await fetch(url,{signal:AbortSignal.timeout(1000)})).status<500)return;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error(`Not ready: ${service.output()}`);}
let browser;
const screenshotDir=process.env.CLAWFIT_SCREENSHOT_DIR;
try {
 const api=start(["--import","tsx","scripts/fixtures/exercise-library-api.ts"]);
 await ready("http://127.0.0.1:4009/health",api);console.log("API ready");
 const web=start(["node_modules/next/dist/bin/next","start","-H","127.0.0.1","-p","3009"],resolve(root,"apps/web"));
 await ready("http://127.0.0.1:3009/auth/signin",web);console.log("Web ready");
 browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const cookie=async(id)=>({name:"authjs.session-token",value:await encode({secret:env.AUTH_SECRET,salt:"authjs.session-token",token:{id,sub:id,name:"Browser test",displayName:"Browser test"}}),url:"http://127.0.0.1:3009",httpOnly:true,sameSite:"Lax"});
 await context.addCookies([await cookie("00000000-0000-0000-0000-000000000002")]);
 const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("http://127.0.0.1:3009/workouts/library");console.log("Library opened",page.url());
 await page.getByRole("status").filter({hasText:"1324 exercises"}).waitFor();
 await page.getByRole("searchbox").fill("flat bench press");
 await page.getByRole("button",{name:/Barbell bench press illustration/}).click();
 await page.getByRole("heading",{name:"Barbell bench press",exact:true}).waitFor();
 await page.getByRole("button",{name:"☆ Favorite",exact:true}).click();
 await page.getByRole("button",{name:"★ Favorited",exact:true}).waitFor();
 await page.getByLabel("Routine",{exact:true}).selectOption({label:"Browser test plan"});
 await page.getByLabel("Position",{exact:true}).selectOption("0");
 await page.getByRole("button",{name:"Replace exercise",exact:true}).click();
 await page.getByRole("status").filter({hasText:"Exercise replaced."}).waitFor();
 const plans=await (await context.request.get("http://127.0.0.1:3009/api/training?plans=true")).json();
 assert.deepEqual(plans.routines[0].exercises[0],{name:"Barbell bench press",libraryId:"edb:0025",muscleGroup:"chest",sets:4,reps:10,restSeconds:120});
 if(screenshotDir){await mkdir(screenshotDir,{recursive:true});await page.screenshot({path:resolve(screenshotDir,"exercise-detail-desktop.png")});}
 await page.getByRole("button",{name:"Close",exact:true}).click();
 await page.getByRole("searchbox").fill("");
 await page.getByLabel("Collection",{exact:true}).selectOption("favorites");
 await page.getByRole("status").filter({hasText:"1 exercises"}).waitFor();
 // Mobile: no overflow, readable filters, create/edit, and keyboard close.
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 if(screenshotDir)await page.screenshot({path:resolve(screenshotDir,"exercise-library-mobile.png"),fullPage:true});
 await page.getByRole("button",{name:"Create exercise",exact:true}).click();
 await page.getByLabel("Name",{exact:true}).fill("Browser custom press");
 await page.getByLabel("Primary group").selectOption("shoulders");
 await page.getByLabel("Primary muscles (comma separated)",{exact:true}).fill("delts");
 await page.getByLabel("Instructions (one step per line)").fill("Sit upright.\nPress slowly.\nLower with control.");
 await page.getByRole("button",{name:"Save exercise",exact:true}).click();
 await page.getByRole("heading",{name:"Browser custom press",exact:true}).waitFor();
 await page.getByRole("button",{name:"Edit custom exercise",exact:true}).click();
 await page.getByLabel("Name",{exact:true}).fill("Renamed custom press");
 await page.getByRole("button",{name:"Save exercise",exact:true}).click();
 await page.getByRole("heading",{name:"Renamed custom press",exact:true}).waitFor();
 await page.keyboard.press("Escape");
 await page.getByRole("dialog").waitFor({state:"hidden"});
 // Partner has an independent collection.
 await context.addCookies([await cookie("00000000-0000-0000-0000-000000000003")]);
 await page.reload();
 await page.getByLabel("Collection",{exact:true}).selectOption("favorites");
 await page.getByRole("heading",{name:"No exercises found",exact:true}).waitFor();
 await page.getByLabel("Collection",{exact:true}).selectOption("custom");
 await page.getByRole("heading",{name:"No exercises found",exact:true}).waitFor();
 // Routine picker and active workout use the same stable ID and instructions.
 await context.addCookies([await cookie("00000000-0000-0000-0000-000000000002")]);
 await page.goto("http://127.0.0.1:3009/workouts?tab=plans");
 await page.getByRole("button",{name:"Edit",exact:true}).click();
 await page.getByRole("button",{name:"Replace from library",exact:true}).click();
 await page.getByRole("searchbox").fill("hammer curl");
 await page.getByRole("button",{name:"Select exercise",exact:true}).first().click();
 await page.getByRole("button",{name:"Save routine",exact:true}).click();
 await page.getByRole("button",{name:"Save routine",exact:true}).waitFor({state:"hidden"});
 await page.goto("http://127.0.0.1:3009/workouts");
 await page.getByRole("button",{name:"Start routine",exact:true}).click();
 await page.getByRole("button",{name:"Instructions",exact:true}).click();
 await page.getByRole("heading",{name:"Instructions",exact:true}).waitFor();
 await page.keyboard.press("Escape");
 assert.equal(errors.length,0,errors.join("\n"));
 console.log("PASS full-stack library browser acceptance: search, favorites, personal isolation, custom create/edit, replacement targets, picker, active instructions, mobile width, Escape; no browser errors.");
} finally {
 await browser?.close();
 for(const child of children.reverse()){if(child.exitCode===null){child.kill("SIGTERM");await Promise.race([once(child,"exit"),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill("SIGKILL");}}
}
