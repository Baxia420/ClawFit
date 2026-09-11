export type Role = "primary" | "partner" | "member" | "owner";

export interface ActorContext {
  userId: string;
  householdId?: string | undefined;
  role?: Role | undefined;
}

export type ResourceType =
  | "meals"
  | "workouts"
  | "user_settings"
  | "notification_preferences"
  | "pending_drafts"
  | "food_presets"
  | "partner_overview"
  | "external_identities";

export type ResourceAction = "read" | "write" | "delete";

export interface ResourceDescriptor {
  ownerUserId: string;
  householdId?: string | undefined;
  type: ResourceType;
}

/**
 * Evaluates whether an actor has permission to perform an action on a resource.
 *
 * Rules:
 * 1. An actor has full read, write, and delete permissions over their own resources.
 * 2. An actor NEVER has write or delete permissions over another user's resources,
 *    even if in the same household and even if the actor has the primary/owner role.
 * 3. An actor in the same household may have read-only access to specific partner health records
 *    ("meals", "workouts", "partner_overview") for shared overview.
 * 4. Partner drafts, private settings, notification preferences, and external identities
 *    are strictly private and NEVER shared, even within the same household.
 * 5. Users in different or unknown households have zero access to each other's data.
 */
export function canAccessResource(
  actor: ActorContext,
  resource: ResourceDescriptor,
  action: ResourceAction,
): boolean {
  if (!actor.userId || !resource.ownerUserId) {
    return false;
  }

  // Rule 1: Own resources
  if (actor.userId === resource.ownerUserId) {
    return true;
  }

  // Rule 2: Partner mutations are strictly forbidden
  if (action !== "read") {
    return false;
  }

  // Rule 5: Cross-household or missing household denies all access
  if (!actor.householdId || !resource.householdId || actor.householdId !== resource.householdId) {
    return false;
  }

  // Rule 4: Private resources never shared
  const privateTypes: ResourceType[] = [
    "pending_drafts",
    "user_settings",
    "notification_preferences",
    "food_presets",
    "external_identities",
  ];
  if (privateTypes.includes(resource.type)) {
    return false;
  }

  // Rule 3: Shared health data read-only within same household
  const shareableReadTypes: ResourceType[] = ["meals", "workouts", "partner_overview"];
  return shareableReadTypes.includes(resource.type);
}

/**
 * Dynamically constructs the web pending meal scope for a given user ID.
 * Avoids hard-coded "web:primary" assumptions and isolates drafts per user.
 */
export function buildWebPendingMealScope(userId: string): string {
  if (!userId || typeof userId !== "string") {
    throw new Error("A valid userId is required to build a web pending meal scope");
  }
  return `web:${userId.trim()}`;
}

/**
 * Verifies if a given pending meal scope key belongs to a specific user.
 */
export function isUserPendingMealScope(scopeKey: string, userId: string): boolean {
  if (!scopeKey || !userId) return false;
  return scopeKey === buildWebPendingMealScope(userId);
}
