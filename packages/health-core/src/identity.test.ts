import { describe, expect, it } from "vitest";
import { normalizeWhatsAppIdentifier } from "./schemas.js";
import { resolveHouseholdTargetUser } from "./identity.js";

describe("normalizeWhatsAppIdentifier", () => {
  it("normalizes E.164 phone numbers with +", () => {
    expect(normalizeWhatsAppIdentifier("+60123456789")).toBe("+60123456789");
    expect(normalizeWhatsAppIdentifier(" +60123456789 ")).toBe("+60123456789");
  });

  it("normalizes raw digit strings to E.164 with + prefix", () => {
    expect(normalizeWhatsAppIdentifier("60123456789")).toBe("+60123456789");
    expect(normalizeWhatsAppIdentifier("14155552671")).toBe("+14155552671");
  });

  it("normalizes WhatsApp phone JIDs to E.164 with + prefix", () => {
    expect(normalizeWhatsAppIdentifier("60123456789@s.whatsapp.net")).toBe("+60123456789");
    expect(normalizeWhatsAppIdentifier("+60123456789@s.whatsapp.net")).toBe("+60123456789");
  });

  it("preserves WhatsApp LID identifiers as lowercase", () => {
    expect(normalizeWhatsAppIdentifier("12345678901234@lid")).toBe("12345678901234@lid");
    expect(normalizeWhatsAppIdentifier(" 12345678901234@LID ")).toBe("12345678901234@lid");
  });

  it("does not conflate different phone numbers or LID with phone numbers", () => {
    const phone = normalizeWhatsAppIdentifier("+60123456789");
    const diffPhone = normalizeWhatsAppIdentifier("+60123456780");
    const lid = normalizeWhatsAppIdentifier("60123456789@lid");

    expect(phone).not.toBe(diffPhone);
    expect(phone).not.toBe(lid);
  });
});

describe("resolveHouseholdTargetUser", () => {
  const primaryUserId = "00000000-0000-0000-0000-000000000002";
  const partnerUserId = "00000000-0000-0000-0000-000000000003";

  it("defaults to requester when targetNameOrAlias is undefined, empty, or self", () => {
    const res1 = resolveHouseholdTargetUser({ requesterUserId: primaryUserId });
    expect(res1).toEqual({
      userId: primaryUserId,
      displayName: "Mahin",
      isDelegated: false,
      relationship: "self",
    });

    const res2 = resolveHouseholdTargetUser({ requesterUserId: primaryUserId, targetNameOrAlias: "" });
    expect(res2?.isDelegated).toBe(false);

    const res3 = resolveHouseholdTargetUser({ requesterUserId: primaryUserId, targetNameOrAlias: "me" });
    expect(res3?.isDelegated).toBe(false);

    const res4 = resolveHouseholdTargetUser({ requesterUserId: primaryUserId, targetNameOrAlias: "myself" });
    expect(res4?.isDelegated).toBe(false);

    const res5 = resolveHouseholdTargetUser({ requesterUserId: primaryUserId, targetNameOrAlias: "Mahin" });
    expect(res5?.isDelegated).toBe(false);
  });

  it("resolves to Cici when Mahin is requester with variations: Cici, partner, her, she", () => {
    const variations = ["Cici", "cici", "Cici's", "partner", "her", "she", "wife", "girlfriend"];
    for (const v of variations) {
      const res = resolveHouseholdTargetUser({
        requesterUserId: primaryUserId,
        targetNameOrAlias: v,
      });
      expect(res).toEqual({
        userId: partnerUserId,
        displayName: "Cici",
        isDelegated: true,
        relationship: "partner",
      });
    }
  });

  it("resolves to Mahin when Cici is requester with variations: Mahin, partner, him, he", () => {
    const variations = ["Mahin", "mahin", "Mahin's", "partner", "him", "he", "husband", "boyfriend"];
    for (const v of variations) {
      const res = resolveHouseholdTargetUser({
        requesterUserId: partnerUserId,
        targetNameOrAlias: v,
      });
      expect(res).toEqual({
        userId: primaryUserId,
        displayName: "Mahin",
        isDelegated: true,
        relationship: "partner",
      });
    }
  });

  it("resolves using explicit household members list", () => {
    const members = [
      { id: "user-alice", displayName: "Alice", role: "primary", active: true },
      { id: "user-bob", displayName: "Bob", role: "partner", active: true },
    ];

    const res = resolveHouseholdTargetUser({
      requesterUserId: "user-alice",
      targetNameOrAlias: "Bob",
      members,
    });
    expect(res).toEqual({
      userId: "user-bob",
      displayName: "Bob",
      isDelegated: true,
      relationship: "partner",
    });

    const resPartnerAlias = resolveHouseholdTargetUser({
      requesterUserId: "user-alice",
      targetNameOrAlias: "partner",
      members,
    });
    expect(resPartnerAlias).toEqual({
      userId: "user-bob",
      displayName: "Bob",
      isDelegated: true,
      relationship: "partner",
    });
  });

  it("returns null for unknown target user outside household", () => {
    const res = resolveHouseholdTargetUser({
      requesterUserId: primaryUserId,
      targetNameOrAlias: "UnknownStranger999",
    });
    expect(res).toBeNull();
  });
});
