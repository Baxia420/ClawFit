import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { InboundTurns } from "./inbound-turns.js";
import { NUTRITION_BASIS, readReplyEstimate } from "./nutrition-reply.js";

async function inbound(text: string) {
  const hooks = new Map<string, Function>();
  const api: any = { on: (name: string, handler: Function) => hooks.set(name, handler), logger: { info: vi.fn() } };
  const turns = new InboundTurns(api);
  const runId = randomUUID(), sessionKey = randomUUID();
  const toolContext: any = { sessionKey, requesterSenderId: "+60111111111", deliveryContext: { to: "test-group@g.us" }, messageChannel: "whatsapp" };
  const replies: unknown[] = [];
  await hooks.get("reply_dispatch")!({ runId, sendPolicy: "allow", sessionKey, ctx: { Provider: "whatsapp", SessionKey: sessionKey, SenderId: toolContext.requesterSenderId, To: toolContext.deliveryContext.to, MessageSid: randomUUID(), RawBody: text } }, { dispatcher: { sendFinalReply: (reply: unknown) => { replies.push(reply); return true; } } });
  const grant = await hooks.get("before_tool_call")!({ toolName: "estimate_nutrition", toolCallId: "estimate", params: { text } }, { runId, sessionKey });
  const turn = turns.forCall(toolContext, "estimate", "estimate_nutrition", grant.params)!;
  return { turns, turn, replies, final: (payload: object) => hooks.get("reply_payload_sending")!({ runId, kind: "final", payload }) };
}

it("replaces misleading model prose with canonical nutrition evidence at dispatch", async () => {
  const { turn, final } = await inbound("Estimate only, don't save this meal");
  turn.replyEstimate = readReplyEstimate({ label: "Biscuits", calories: { best: 210, low: 180, high: 250 }, macros: { proteinG: 2.5, carbsG: 30, fatG: 9, fiberG: 1 }, confidence: "low", uncertaintyReasons: ["Unknown packet weight"] })!;
  const result = final({ text: "Verified online: exactly 9999 kcal and 42 g. Logged!", mediaUrl: "/untrusted/model/image.png" });
  expect(result.payload.text).toContain("210 kcal (180–250)");
  expect(result.payload.text).toContain("Confidence: low");
  expect(result.payload.text).toContain("Unknown packet weight");
  expect(result.payload.text).toContain("Not logged.");
  expect(JSON.stringify(result)).not.toMatch(/9999|42 g|Logged!|mediaUrl|Reply yes/);
  expect(final({ text: "duplicate" })).toMatchObject({ cancel: true });
});

it("corrects the observed invented online-lookup explanation at dispatch", async () => {
  const { final } = await inbound("Did you look up the values online? How did calculation came across");
  expect(final({ text: "Yep, searched a food database and verified 42 grams" }).payload).toEqual({ text: NUTRITION_BASIS, isError: false });
});

it("keeps terminal failure handling ahead of a previously successful estimate", async () => {
  const { turn, turns, replies, final } = await inbound("Estimate and log it");
  turns.fail(turn, "log_meal", { error: "service_unavailable", message: "The service is unavailable.", retryable: false });
  expect(replies).toHaveLength(1);
  expect(final({ text: "Logged!" })).toMatchObject({ cancel: true });
});
