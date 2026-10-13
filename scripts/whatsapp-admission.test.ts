import { expect, it, vi, afterEach } from "vitest";
import { pathToFileURL, fileURLToPath } from "node:url";
const { admitWhatsAppMessage } = await import(pathToFileURL(fileURLToPath(new URL("whatsapp-admission.mjs", import.meta.url))).href);
const ctx = (id: string, text = "", sender = "sender-a") => ({ MessageSid: id, SenderId: sender, MediaPaths: [`/inbound/${id}.png`], MediaType: "image/png", RawBody: text });
afterEach(() => vi.useRealTimers());
it("collects three trusted images with one caption, reuses retransmissions, and sends once", async () => {
 vi.useFakeTimers();
 const dispatch = vi.fn(async (params: { ctx: { MediaPaths: string[]; RawBody: string } }) => params.ctx);
 const a = admitWhatsAppMessage({ ctx: ctx("a", "2 eggs with 185g rice, estimate only") }, "three", dispatch);
 const b = admitWhatsAppMessage({ ctx: ctx("b") }, "three", dispatch);
 const c = admitWhatsAppMessage({ ctx: ctx("c") }, "three", dispatch);
 const duplicate = admitWhatsAppMessage({ ctx: ctx("b") }, "three", dispatch);
 await vi.advanceTimersByTimeAsync(1800);
 const results = await Promise.all([a,b,c,duplicate]);
 expect(dispatch).toHaveBeenCalledTimes(1);
 expect(results[0]).toMatchObject({ MediaPaths: ["/inbound/a.png", "/inbound/b.png", "/inbound/c.png"], RawBody: "2 eggs with 185g rice, estimate only" });
 expect(results.every(row => row === results[0])).toBe(true);
});
it("keeps another sender and a second caption separate, and serializes through completed delivery", async () => {
 vi.useFakeTimers();
 const captured: string[][] = [];
 let finish: () => void = () => {};
 const gate = new Promise<void>(resolve => { finish = resolve; });
 const dispatch = vi.fn(async (params: { ctx: { MediaPaths: string[] } }) => { captured.push(params.ctx.MediaPaths); if (captured.length === 1) await gate; return true; });
 const a = admitWhatsAppMessage({ ctx: ctx("first", "First meal") }, "separate", dispatch);
 const b = admitWhatsAppMessage({ ctx: ctx("other", "", "sender-b") }, "separate", dispatch);
 const c = admitWhatsAppMessage({ ctx: ctx("second", "Another meal") }, "separate", dispatch);
 await vi.advanceTimersByTimeAsync(1800);
 expect(captured).toEqual([["/inbound/first.png"]]);
 finish(); await Promise.all([a,b,c]);
 expect(captured).toEqual([["/inbound/first.png"], ["/inbound/other.png"], ["/inbound/second.png"]]);
});
it("a later photo does not borrow an earlier completed turn's image", async () => {
 vi.useFakeTimers(); const dispatch = vi.fn(async (params: { ctx: unknown }) => params.ctx);
 const first = admitWhatsAppMessage({ ctx: ctx("old") }, "later", dispatch);
 await vi.advanceTimersByTimeAsync(1800); await first;
 const next = admitWhatsAppMessage({ ctx: ctx("new") }, "later", dispatch);
 await vi.advanceTimersByTimeAsync(1800);
 expect(await next).toMatchObject({ MediaPaths: ["/inbound/new.png"] });
 expect(dispatch).toHaveBeenCalledTimes(2);
});
it("accepts a caption on the last companion and isolates another account or conversation route", async () => {
 vi.useFakeTimers();
 const dispatch = vi.fn(async (params: { ctx: unknown }) => params.ctx);
 const first = admitWhatsAppMessage({ ctx: ctx("late-a") }, "account-a:chat-a", dispatch);
 const other = admitWhatsAppMessage({ ctx: ctx("route-b") }, "account-b:chat-a", dispatch);
 const last = admitWhatsAppMessage({ ctx: ctx("late-b", "Three components, estimate only") }, "account-a:chat-a", dispatch);
 await vi.advanceTimersByTimeAsync(1800);
 expect(await first).toEqual(await last);
 expect(await first).toMatchObject({ MediaPaths: ["/inbound/late-a.png", "/inbound/late-b.png"], RawBody: "Three components, estimate only" });
 expect(await other).toMatchObject({ MediaPaths: ["/inbound/route-b.png"] });
 expect(dispatch).toHaveBeenCalledTimes(2);
});
it.each([true, false])("shares only explicit provider delivery with companions: %s", async visibleReplySent => {
 vi.useFakeTimers();
 const delivered = vi.fn(async () => ({ visibleReplySent }));
 const dispatch = vi.fn(async (params: { dispatcherOptions: { deliver: () => Promise<unknown> } }) => {
  await params.dispatcherOptions.deliver(); return { queuedFinal: true };
 });
 const first = admitWhatsAppMessage({ ctx: ctx(`visible-a-${visibleReplySent}`, "Estimate only"), dispatcherOptions: { deliver: delivered } }, `visibility-${visibleReplySent}`, dispatch);
 const companion = admitWhatsAppMessage({ ctx: ctx(`visible-b-${visibleReplySent}`), dispatcherOptions: { deliver: delivered } }, `visibility-${visibleReplySent}`, dispatch);
 await vi.advanceTimersByTimeAsync(1800);
 expect(await first).toEqual(await companion);
 expect(await companion).toEqual(visibleReplySent ? { queuedFinal: true, observedReplyDelivery: true } : { queuedFinal: true });
 expect(delivered).toHaveBeenCalledTimes(1);
});
