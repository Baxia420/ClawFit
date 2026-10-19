import type { GoogleCredential } from "@clawfit/health-core";
import { z } from "zod";

const quotaBody = z.object({ error: z.object({ details: z.array(z.object({
  "@type": z.string().optional(),
  retryDelay: z.string().optional(),
  violations: z.array(z.object({ quotaId: z.string().optional(), quotaMetric: z.string().optional() })).optional(),
})).optional() }).optional() });

/** Google's daily request quotas reset at midnight in America/Los_Angeles. */
export function nextPacificMidnight(now: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
  const date = (time: number) => formatter.format(time);
  // Find the date boundary, including DST transitions, without assuming a UTC offset.
  let low = now, high = now + 26 * 60 * 60 * 1000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (date(mid) === date(now)) low = mid; else high = mid;
  }
  return high;
}

export function quotaCooldown(response: Response, body: unknown, now: number): { until: number; scope: "minute_or_unknown" | "daily" } {
  const details = quotaBody.safeParse(body).data?.error?.details ?? [];
  const daily = details.some(detail => detail["@type"]?.endsWith("google.rpc.QuotaFailure") && detail.violations?.some(v => /per.?day|daily/i.test(`${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`)));
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const headerMs = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - now : 0;
  const bodyMs = details.flatMap(detail => {
    if (!detail["@type"]?.endsWith("google.rpc.RetryInfo")) return [];
    const match = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay ?? "");
    return match ? [Number(match[1]) * 1000] : [];
  });
  const hints = [headerMs, ...bodyMs].filter(ms => Number.isFinite(ms) && ms > 0);
  const waitMs = hints.length ? Math.max(...hints) : 60_000;
  return { until: Math.max(now + waitMs, daily ? nextPacificMidnight(now) : now), scope: daily ? "daily" : "minute_or_unknown" };
}

export class GeminiCredentialPool {
  private readonly cooldowns = new Map<string, Map<string, number>>();
  private readonly disabled = new Set<string>();
  private readonly preferred = new Map<string, string>();
  constructor(private readonly credentials: readonly GoogleCredential[]) {
    if (!credentials.length) throw new Error("At least one Google credential is required.");
  }
  select(model: string, now: number, excluded = new Set<string>(), currentId?: string): GoogleCredential | undefined {
    const preferred = currentId ?? this.preferred.get(model);
    const eligible = this.credentials.filter(c => !excluded.has(c.id) && !this.disabled.has(c.id) && (this.cooldowns.get(model)?.get(c.id) ?? 0) <= now);
    return eligible.find(c => c.id === preferred) ?? eligible[0];
  }
  coolDown(model: string, id: string, until: number): void {
    const state = this.cooldowns.get(model) ?? new Map<string, number>();
    state.set(id, Math.max(state.get(id) ?? 0, until));
    this.cooldowns.set(model, state);
  }
  disable(id: string): void { this.disabled.add(id); }
  unavailableMessage(): string {
    return this.credentials.every(c => this.disabled.has(c.id))
      ? "Gemini credentials unavailable (401); replace invalid credentials and restart."
      : "Gemini credentials unavailable (429); wait for quota recovery.";
  }
  succeed(model: string, id: string): void {
    // A concurrent success must not erase a more recent rate-limit cooldown.
    this.preferred.set(model, id);
  }
}
