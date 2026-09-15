export const DEFAULT_HOUSEHOLD_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_PRIMARY_USER_ID = "00000000-0000-0000-0000-000000000002";
export const DEFAULT_PARTNER_USER_ID = "00000000-0000-0000-0000-000000000003";

export interface HouseholdMemberUser {
  id: string;
  displayName: string;
  role?: string | undefined;
  active?: boolean | undefined;
}

export interface ResolveHouseholdTargetUserInput {
  requesterUserId: string;
  targetNameOrAlias?: string | null | undefined;
  householdId?: string | undefined;
  members?: readonly HouseholdMemberUser[] | undefined;
}

export interface ResolvedTargetUser {
  userId: string;
  displayName: string;
  isDelegated: boolean;
  relationship: "self" | "partner" | "member";
}

const DEFAULT_MEMBERS: readonly HouseholdMemberUser[] = [
  { id: DEFAULT_PRIMARY_USER_ID, displayName: "Mahin", role: "primary", active: true },
  { id: DEFAULT_PARTNER_USER_ID, displayName: "Cici", role: "partner", active: true },
];

/**
 * Normalizes input name/alias by trimming, lowercasing, and stripping
 * punctuation or possessive suffixes (e.g. "Cici's" -> "cici").
 */
function normalizeTargetName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim();
}

/**
 * Resolves whether a meal or query should be attributed to the requester
 * or delegated to a household member (e.g. "Cici", "partner", "her", "she").
 */
export function resolveHouseholdTargetUser(
  input: ResolveHouseholdTargetUserInput,
): ResolvedTargetUser | null {
  const { requesterUserId, targetNameOrAlias } = input;
  const members = input.members && input.members.length > 0 ? input.members : DEFAULT_MEMBERS;

  const requesterMember = members.find((m) => m.id === requesterUserId);
  const requesterName = requesterMember?.displayName ?? (requesterUserId === DEFAULT_PRIMARY_USER_ID ? "Mahin" : "Requester");

  // 1. Missing, empty, or self-directed alias defaults to the requester
  if (!targetNameOrAlias || !targetNameOrAlias.trim()) {
    return {
      userId: requesterUserId,
      displayName: requesterName,
      isDelegated: false,
      relationship: "self",
    };
  }

  const normalized = normalizeTargetName(targetNameOrAlias);

  // Self aliases
  if (["me", "myself", "i", "mine", "self"].includes(normalized) || normalized === requesterName.toLowerCase()) {
    return {
      userId: requesterUserId,
      displayName: requesterName,
      isDelegated: false,
      relationship: "self",
    };
  }

  // 2. Direct name match in provided household members
  const directMemberMatch = members.find(
    (m) => m.active !== false && normalizeTargetName(m.displayName) === normalized,
  );
  if (directMemberMatch) {
    const isSelf = directMemberMatch.id === requesterUserId;
    return {
      userId: directMemberMatch.id,
      displayName: directMemberMatch.displayName,
      isDelegated: !isSelf,
      relationship: isSelf ? "self" : (directMemberMatch.role === "partner" || directMemberMatch.role === "primary") ? "partner" : "member",
    };
  }

  // 3. Pronoun and partner alias resolution
  const isPartnerAlias = ["partner", "spouse", "significant other", "so"].includes(normalized);
  const isFemalePronoun = ["her", "she", "wife", "girlfriend", "gf"].includes(normalized);
  const isMalePronoun = ["him", "he", "husband", "boyfriend", "bf"].includes(normalized);

  // When requester is Primary User (Mahin):
  if (requesterUserId === DEFAULT_PRIMARY_USER_ID) {
    if (normalized === "cici" || isPartnerAlias || isFemalePronoun) {
      const partnerMember = members.find((m) => m.id === DEFAULT_PARTNER_USER_ID) ?? {
        id: DEFAULT_PARTNER_USER_ID,
        displayName: "Cici",
        role: "partner",
        active: true,
      };
      return {
        userId: partnerMember.id,
        displayName: partnerMember.displayName,
        isDelegated: true,
        relationship: "partner",
      };
    }
  }

  // When requester is Partner User (Cici):
  if (requesterUserId === DEFAULT_PARTNER_USER_ID) {
    if (normalized === "mahin" || isPartnerAlias || isMalePronoun) {
      const primaryMember = members.find((m) => m.id === DEFAULT_PRIMARY_USER_ID) ?? {
        id: DEFAULT_PRIMARY_USER_ID,
        displayName: "Mahin",
        role: "primary",
        active: true,
      };
      return {
        userId: primaryMember.id,
        displayName: primaryMember.displayName,
        isDelegated: true,
        relationship: "partner",
      };
    }
  }

  // Generic household partner lookup: find another active member who is not the requester
  if (isPartnerAlias || isFemalePronoun || isMalePronoun) {
    const otherMembers = members.filter((m) => m.id !== requesterUserId && m.active !== false);
    if (otherMembers.length === 1) {
      const other = otherMembers[0]!;
      return {
        userId: other.id,
        displayName: other.displayName,
        isDelegated: true,
        relationship: (other.role === "partner" || other.role === "primary") ? "partner" : "member",
      };
    }
  }

  // Phrase pattern matching for phrases like "what did she eat", "for cici", "cici ate", "she had", "her meals"
  if (requesterUserId === DEFAULT_PRIMARY_USER_ID) {
    if (/\b(cici|partner|wife|girlfriend|gf|she|her)\b/i.test(normalized)) {
      const partnerMember = members.find((m) => m.id === DEFAULT_PARTNER_USER_ID) ?? {
        id: DEFAULT_PARTNER_USER_ID,
        displayName: "Cici",
        role: "partner",
        active: true,
      };
      return {
        userId: partnerMember.id,
        displayName: partnerMember.displayName,
        isDelegated: true,
        relationship: "partner",
      };
    }
  }

  if (requesterUserId === DEFAULT_PARTNER_USER_ID) {
    if (/\b(mahin|partner|husband|boyfriend|bf|he|him)\b/i.test(normalized)) {
      const primaryMember = members.find((m) => m.id === DEFAULT_PRIMARY_USER_ID) ?? {
        id: DEFAULT_PRIMARY_USER_ID,
        displayName: "Mahin",
        role: "primary",
        active: true,
      };
      return {
        userId: primaryMember.id,
        displayName: primaryMember.displayName,
        isDelegated: true,
        relationship: "partner",
      };
    }
  }

  return null;
}
