export const WEB_PENDING_MEAL_SCOPE = "web:primary";

export function withWebPendingMealScope(path: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}scopeKey=${encodeURIComponent(WEB_PENDING_MEAL_SCOPE)}`;
}
