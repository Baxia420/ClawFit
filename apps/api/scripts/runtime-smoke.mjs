import { readdir } from "node:fs/promises";

const workspaceImports = ["@clawfit/health-core", "@clawfit/db", "@clawfit/db/schema"];

for (const specifier of workspaceImports) {
  const resolved = import.meta.resolve(specifier);
  if (!new URL(resolved).pathname.includes("/dist/")) {
    throw new Error(`${specifier} resolved outside compiled output: ${resolved}`);
  }
  await import(specifier);
  console.log(`${specifier} -> ${resolved}`);
}

for (const directory of ["../src", "../dist"]) {
  const entries = await readdir(new URL(directory, import.meta.url));
  const ambiguousEntrypoint = entries.find((entry) => entry.startsWith("app."));
  if (ambiguousEntrypoint) {
    throw new Error(`${directory}/${ambiguousEntrypoint} can be misdetected as a Vercel entrypoint`);
  }
}

await import("../dist/create-app.js");
console.log("Compiled API runtime imports resolved");
