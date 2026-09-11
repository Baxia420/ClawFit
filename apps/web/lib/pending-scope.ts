import { buildWebPendingMealScope } from "@clawfit/health-core";

export function resolveWebPendingMealScope(userId: string): string {
  if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Missing user identity for web pending meal scope");
  }
  return buildWebPendingMealScope(userId.trim());
}

export function withWebPendingMealScope(path: string, scopeKeyOrUserId: string): string {
  if (!scopeKeyOrUserId || typeof scopeKeyOrUserId !== "string" || scopeKeyOrUserId.trim().length === 0) {
    throw new Error("Missing scopeKey or userId for web pending meal scope");
  }
  const scopeKey = scopeKeyOrUserId.startsWith("web:")
    ? scopeKeyOrUserId
    : buildWebPendingMealScope(scopeKeyOrUserId.trim());
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}scopeKey=${encodeURIComponent(scopeKey)}`;
}

