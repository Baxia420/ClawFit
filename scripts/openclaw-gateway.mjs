// Launch the existing global CLI with a verified, process-local compatibility
// layer. Keep its installation, plugin resolution, HOME and state unchanged.
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkRuntimeCompatibility, installRuntimeCompatibility } from "./openclaw-runtime-compat.mjs";

const executable = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  .map(directory => path.join(directory, "openclaw"))
  .find(candidate => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
if (!executable) throw new Error("OpenClaw CLI missing from service PATH.");
const entry = realpathSync(executable);
const root = path.dirname(entry);
if (process.argv[2] === "--check") {
  checkRuntimeCompatibility(root);
  console.log("ClawFit WhatsApp dispatch compatibility verified for OpenClaw 2026.7.1-2.");
} else {
  installRuntimeCompatibility(root);
  process.argv = [process.execPath, entry, ...process.argv.slice(2)];
  await import(pathToFileURL(entry).href);
}
