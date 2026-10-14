import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe,it,expect } from "vitest";
import manifest from "../docs/licenses/exercise-media.json" with { type:"json" };
import catalogue from "../packages/db/src/catalogue/exercises.json" with { type:"json" };
describe("licensed exercise assets",()=>{
 it("ships only the documented unchanged media and retains the text notice",async()=>{
  expect(manifest).toHaveLength(38);
  expect(new Set(manifest.map(m=>m.exerciseId)).size).toBe(19);
  for(const asset of manifest){
   expect(asset.author).toBe("Everkinetic");expect(asset.license).toBe("CC BY-SA 3.0");
   expect(asset.sourceUrl).toMatch(/^https:\/\/wger.de\/media\/exercise-images\//);
   const bytes=await readFile(new URL(`../apps/web/public${asset.src}`,import.meta.url));
   expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
   expect(bytes.length).toBe(asset.bytes);
   expect(catalogue.find(e=>e.id===asset.exerciseId)?.media.some(m=>m.src===asset.src)).toBe(true);
  }
  expect(catalogue.flatMap(e=>e.media)).toHaveLength(manifest.length);
  const notice=await readFile(new URL("../apps/web/public/exercise-media/text-license.txt",import.meta.url),"utf8");
  expect(notice).toContain("Hasan Emir Yıldırım");expect(notice).toContain("MEDIA EXCEPTION");
 });
});
