const workspaceImports = ["@clawfit/health-core", "@clawfit/db", "@clawfit/db/schema"];

for (const specifier of workspaceImports) {
  const resolved = import.meta.resolve(specifier);
  if (!new URL(resolved).pathname.includes("/dist/")) {
    throw new Error(`${specifier} resolved outside compiled output: ${resolved}`);
  }
  await import(specifier);
  console.log(`${specifier} -> ${resolved}`);
}

await import("../dist/app.js");
console.log("Compiled API runtime imports resolved");
