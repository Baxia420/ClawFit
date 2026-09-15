import {
  resolveHouseholdTargetUser,
  DEFAULT_PRIMARY_USER_ID,
  DEFAULT_PARTNER_USER_ID,
  type HouseholdMemberUser,
  type ResolvedTargetUser,
} from "@clawfit/health-core";
import { healthFetch, type HealthPluginConfig, type SenderContext } from "./health-client.js";

const householdMembersCache = new Map<string, { members: HouseholdMemberUser[]; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const FALLBACK_MEMBERS: readonly HouseholdMemberUser[] = [
  { id: DEFAULT_PRIMARY_USER_ID, displayName: "Mahin", role: "primary", active: true },
  { id: DEFAULT_PARTNER_USER_ID, displayName: "Cici", role: "partner", active: true },
];

export const PHONE_MAHIN = "+60143224693";
export const PHONE_CICI = "+60142419432";

export function isCiciPhone(phone?: string | null): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.endsWith("142419432") || digits.includes("60142419432");
}

export function isMahinPhone(phone?: string | null): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.endsWith("143224693") || digits.includes("60143224693");
}

export function containsPartnerReference(text?: string | null): boolean {
  if (!text) return false;
  return /\b(cici|partner|wife|girlfriend|gf|she|her|for\s+cici|cici\s+(?:ate|had|eats)|she\s+(?:had|ate|only\s+had)|her\s+meals?|what\s+did\s+(?:she|cici)\s+eat|what\s+did\s+(?:she|cici)\s+have)\b/i.test(text);
}

export function containsPrimaryReference(text?: string | null): boolean {
  if (!text) return false;
  return /\b(mahin|partner|husband|boyfriend|bf|he|him|for\s+mahin|mahin\s+(?:ate|had|eats)|he\s+(?:had|ate|only\s+had)|his\s+meals?|what\s+did\s+(?:he|mahin)\s+eat|what\s+did\s+(?:he|mahin)\s+have)\b/i.test(text);
}

export async function resolveTargetUserContext(options: {
  config: HealthPluginConfig;
  sender?: SenderContext | undefined;
  targetUserName?: string | undefined;
  targetUserId?: string | undefined;
  userPrompt?: string | undefined;
}): Promise<ResolvedTargetUser> {
  const { config, sender, targetUserName, targetUserId, userPrompt } = options;

  const isCiciSender = isCiciPhone(sender?.senderId);
  const requesterUserId = isCiciSender ? DEFAULT_PARTNER_USER_ID : DEFAULT_PRIMARY_USER_ID;

  if (targetUserId) {
    const isDelegated = targetUserId !== requesterUserId;
    return {
      userId: targetUserId,
      displayName: targetUserName ?? (targetUserId === DEFAULT_PARTNER_USER_ID ? "Cici" : "Mahin"),
      isDelegated,
      relationship: isDelegated ? "partner" : "self",
    };
  }

  let candidate = targetUserName?.trim();
  if (!candidate && userPrompt) {
    if (!isCiciSender && containsPartnerReference(userPrompt)) {
      candidate = "Cici";
    } else if (isCiciSender && containsPrimaryReference(userPrompt)) {
      candidate = "Mahin";
    }
  }

  let members: readonly HouseholdMemberUser[] = FALLBACK_MEMBERS;
  const senderKey = sender?.senderId ?? "default";
  const cached = householdMembersCache.get(senderKey);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    members = cached.members;
  } else {
    try {
      const data = await healthFetch<{ household: { id: string }; members: HouseholdMemberUser[] }>(
        config,
        "/v1/household/members",
        { sender },
      );
      if (Array.isArray(data?.members) && data.members.length > 0) {
        members = data.members;
        householdMembersCache.set(senderKey, { members: data.members, timestamp: now });
      }
    } catch {
      // Gracefully fall back to FALLBACK_MEMBERS
    }
  }

  if (candidate) {
    const resolved = resolveHouseholdTargetUser({
      requesterUserId,
      targetNameOrAlias: candidate,
      members,
    });
    if (resolved) return resolved;
  }

  // If no delegation candidate exists, strictly default to sender identity:
  if (isCiciSender) {
    return {
      userId: DEFAULT_PARTNER_USER_ID,
      displayName: "Cici",
      isDelegated: false,
      relationship: "self",
    };
  }

  return {
    userId: DEFAULT_PRIMARY_USER_ID,
    displayName: "Mahin",
    isDelegated: false,
    relationship: "self",
  };
}
