// Inputs are finalized channel-owned contexts, before any plugin/model hook.
// One caption plus nearby captionless photos forms one collection. A second
// caption, another sender/account/route, or a later photo starts another turn.
const tails = new Map();
const batches = new Map();
const receipts = new Map();
const WINDOW_MS = 1800;
const MAX_WAIT_MS = 5000;

const paths = ctx => [...new Set([...(ctx.MediaPaths ?? []), ...(ctx.MediaPath ? [ctx.MediaPath] : [])])];
const caption = ctx => (ctx.BodyForCommands ?? ctx.RawBody ?? "").trim().replace(/^<media:image>$/i, "");
const image = ctx => paths(ctx).length && (ctx.MediaType?.startsWith("image/") || ctx.MediaTypes?.some(type => type.startsWith("image/")));

function enqueue(key, run) {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  tails.set(key, current);
  return current.finally(() => { if (tails.get(key) === current) tails.delete(key); });
}

export function admitWhatsAppMessage(params, routeKey, dispatch) {
  const ctx = params.ctx;
  const now = Date.now();
  for (const [key, receipt] of receipts) if (now - receipt.receivedAt > 30 * 60_000) receipts.delete(key);
  while (receipts.size > 2048) receipts.delete(receipts.keys().next().value);
  const id = ctx.MessageSidFull ?? ctx.MessageSid;
  const identity = ctx.SenderId && id ? JSON.stringify([routeKey, ctx.SenderId]) : undefined;
  const messageKey = identity ? JSON.stringify([identity, id]) : undefined;
  const prior = messageKey ? receipts.get(messageKey) : undefined;
  if (prior) return prior.result;

  // Reserve order immediately, including while an earlier photo is collecting.
  if (!image(ctx) || !identity) {
    for (const batch of batches.values()) if (batch.routeKey === routeKey) batch.seal();
    return enqueue(routeKey, () => dispatch(params));
  }
  const text = caption(ctx);
  let batch = batches.get(identity);
  if (batch && (batch.sealed || now - batch.createdAt >= MAX_WAIT_MS || (text && batch.text))) {
    batch.seal(); batch = undefined;
  }
  if (!batch) {
    let ready;
    const admission = new Promise(resolve => { ready = resolve; });
    batch = { routeKey, createdAt: now, text, contexts: [ctx], sealed: false, timer: undefined, result: undefined,
      seal() {
        if (this.sealed) return;
        this.sealed = true; clearTimeout(this.timer);
        if (batches.get(identity) === this) batches.delete(identity);
        const files = this.contexts.flatMap(paths);
        if (this.contexts.length > 1) {
          const texts = this.contexts.map(caption).filter(Boolean);
          const mediaTypes = this.contexts.flatMap(source => source.MediaTypes ?? [source.MediaType]);
          params.ctx = { ...ctx, MediaPath: files[0], MediaPaths: files, MediaUrl: files[0], MediaUrls: files, MediaType: mediaTypes[0], MediaTypes: mediaTypes,
            RawBody: texts.join("\n"), BodyForCommands: texts.join("\n"), CommandBody: texts.join("\n"),
            BodyForAgent: [ctx.BodyForAgent ?? ctx.Body ?? "", ...this.contexts.slice(1).map(caption).filter(Boolean)].join("\n"),
            MessageSidFirst: ctx.MessageSid, MessageSidLast: this.contexts.at(-1).MessageSid };
        }
        console.info(`[clawfit-runtime] ${JSON.stringify({ reason: "photo_collection_admitted", messageCount: this.contexts.length, attachmentCount: files.length, hasCaption: Boolean(this.text) })}`);
        ready();
      },
    };
    const current = batch;
    batch.result = enqueue(routeKey, async () => {
      await admission;
      let visible = false;
      const options = params.dispatcherOptions;
      const observe = result => { if (result?.visibleReplySent === true) visible = true; return result; };
      // The WhatsApp wrapper finalizes each photo's status after this promise.
      // Companions have no separate delivery callback: share the primary's
      // explicit provider outcome, never infer delivery from a queued payload.
      const dispatched = options ? { ...params, dispatcherOptions: { ...options,
        deliver: async (...args) => observe(await options.deliver(...args)),
        ...(options.onSettled ? { onSettled: async () => observe(await options.onSettled()) } : {}),
      } } : params;
      const result = await dispatch(dispatched);
      return visible ? { ...result, observedReplyDelivery: true } : result;
    });
    batches.set(identity, current);
  } else {
    batch.contexts.push(ctx);
    if (text) batch.text = text;
  }
  clearTimeout(batch.timer);
  if (batch.contexts.flatMap(paths).length > 4) batch.seal(); // resolver returns the existing safe limit error
  else batch.timer = setTimeout(() => batch.seal(), Math.min(WINDOW_MS, MAX_WAIT_MS - (now - batch.createdAt)));
  if (messageKey) receipts.set(messageKey, { receivedAt: now, result: batch.result });
  return batch.result;
}
