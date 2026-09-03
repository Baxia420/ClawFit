import { describe, expect, it } from "vitest";
import { normalizeWhatsAppIdentifier } from "./schemas.js";

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
