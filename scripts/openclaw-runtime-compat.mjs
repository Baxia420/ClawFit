// Compatibility for the exact deployed OpenClaw build. Applied in memory only;
// neither the global installation nor channel/credential state is modified.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = "2026.7.1-2";
const bundle = "dispatch-DnzGTpPs.js";
const digest = "6b62dc3b875af0a8b72509c69dea53808683eeef658fbb94d25f6875a4d53316";
const declaration = "async function dispatchInboundMessageWithBufferedDispatcher(params) {";
const replacement = `
// ClawFit: admit one WhatsApp message per route before the foreground fence.
// Do not merge messages, steer an active run, or modify any attachment context.
const clawfitWhatsAppDispatches = new Map();
async function dispatchInboundMessageWithBufferedDispatcher(params) {
  const ctx = finalizeInboundContext(params.ctx);
  const channel = ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider;
  const key = channel === "whatsapp" && params.cfg.plugins?.entries?.["clawfit-health"]?.enabled === true
    ? resolveForegroundReplyFenceKey(ctx) : undefined;
  if (!key) return clawfitDispatchWithoutAdmission(params);
  const previous = clawfitWhatsAppDispatches.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => clawfitDispatchWithoutAdmission(params));
  clawfitWhatsAppDispatches.set(key, current);
  try { return await current; }
  finally { if (clawfitWhatsAppDispatches.get(key) === current) clawfitWhatsAppDispatches.delete(key); }
}
async function clawfitDispatchWithoutAdmission(params) {`;

function checkedSource(source) {
  if (createHash("sha256").update(source).digest("hex") !== digest || source.split(declaration).length !== 2) {
    throw new Error("ClawFit runtime compatibility check failed: dispatch bundle changed. Revalidate before deploying.");
  }
  return source.replace(declaration, replacement);
}

export function checkRuntimeCompatibility(root) {
  if (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version !== version) {
    throw new Error(`ClawFit runtime compatibility requires OpenClaw ${version}.`);
  }
  checkedSource(readFileSync(path.join(root, "dist", bundle), "utf8"));
}

export function installRuntimeCompatibility(root) {
  checkRuntimeCompatibility(root);
  return registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      // The host can load a separate SDK copy for plugin discovery. Validate
      // every matching copy before transforming it; never patch unknown builds.
      if (url.startsWith("file:") && fileURLToPath(url).endsWith(`/openclaw/dist/${bundle}`)) {
        const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
        return { ...loaded, source: checkedSource(source) };
      }
      return loaded;
    },
  });
}
