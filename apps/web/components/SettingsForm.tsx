"use client";

import { FormEvent, useState } from "react";
import type { NotificationPreference, NotificationType, Settings } from "../lib/api";

const notificationMeta: Record<NotificationType, { label: string; description: string; defaultTime: string }> = {
  meal_reminder: { label: "Meal reminder", description: "A nudge when a meal window passes without an entry.", defaultTime: "13:00" },
  workout_reminder: { label: "Workout reminder", description: "A scheduled prompt to begin training.", defaultTime: "18:00" },
  evening_progress: { label: "Evening progress", description: "Calories and protein remaining near the end of the day.", defaultTime: "20:00" },
  unfinished_workout: { label: "Unfinished workout", description: "A reminder when an active session is still open.", defaultTime: "22:00" },
  daily_summary: { label: "Daily summary", description: "A compact end-of-day nutrition and training report.", defaultTime: "21:30" },
  weekly_summary: { label: "Weekly summary", description: "Seven-day intake and performance overview.", defaultTime: "19:00" },
};
const dayLabels = [
  { short: "M", full: "Monday" },
  { short: "T", full: "Tuesday" },
  { short: "W", full: "Wednesday" },
  { short: "T", full: "Thursday" },
  { short: "F", full: "Friday" },
  { short: "S", full: "Saturday" },
  { short: "S", full: "Sunday" },
];

export function SettingsForm({ initialSettings, savedPreferences }: { initialSettings: Settings; savedPreferences: NotificationPreference[] }) {
  const [settings, setSettings] = useState({ ...initialSettings, preferredUnits: "metric" as const });
  const [preferences, setPreferences] = useState(() => Object.entries(notificationMeta).map(([type, meta]) => savedPreferences.find((item) => item.type === type) ?? {
    type: type as NotificationType,
    enabled: false,
    timeLocal: meta.defaultTime,
    timezone: initialSettings.timezone,
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    deliveryChannel: "web_push" as const,
    configuration: {},
  }));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState("");

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    await persist("goals", "PATCH", settings);
    setPreferences((current) => current.map((item) => ({ ...item, timezone: settings.timezone })));
  }

  async function savePreference(preference: NotificationPreference) {
    await persist(preference.type, "PUT", { ...preference, timezone: settings.timezone });
  }

  async function persist(key: string, method: "PATCH" | "PUT", body: unknown) {
    setBusy(key);
    setStatus("");
    try {
      const response = await fetch("/api/settings", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Save failed");
      setStatus(key === "goals" ? "Goals and locale saved." : `${notificationMeta[key as NotificationType].label} saved.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy("");
    }
  }

  function updatePreference(type: NotificationType, patch: Partial<NotificationPreference>) {
    setPreferences((current) => current.map((item) => item.type === type ? { ...item, ...patch } : item));
  }

  return <div className="settings-stack">
    <form className="panel settings-panel" onSubmit={saveSettings}>
      <div className="panel-title"><span>01 / GOALS & LOCALE</span><strong>authoritative defaults</strong></div>
      <div className="settings-grid">
        <label>Calorie target<input type="number" min="500" max="10000" value={settings.calorieTarget} onChange={(event) => setSettings({ ...settings, calorieTarget: Number(event.target.value) })} /><small>KCAL / DAY</small></label>
        <label>Protein target<input type="number" min="10" max="1000" value={settings.proteinTargetG} onChange={(event) => setSettings({ ...settings, proteinTargetG: Number(event.target.value) })} /><small>GRAMS / DAY</small></label>
        <label>Timezone<input value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })} /><small>IANA NAME</small></label>
        <label>Preferred units<select value="metric" disabled><option value="metric">Metric / kg</option></select><small>V1 / KG ONLY</small></label>
      </div>
      <footer><button type="submit" disabled={busy === "goals"}>SAVE GOALS</button></footer>
    </form>

    <section className="panel notification-panel">
      <div className="panel-title"><span>02 / NOTIFICATION RULES</span><strong>delivery foundation</strong></div>
      <div className="notification-list">
        {preferences.map((preference) => {
          const meta = notificationMeta[preference.type];
          return <article key={preference.type}>
            <label className="switch-row"><input type="checkbox" checked={preference.enabled} onChange={(event) => updatePreference(preference.type, { enabled: event.target.checked })} /><span className="toggle" /><div><strong>{meta.label}</strong><small>{meta.description}</small></div></label>
            <div className="schedule-row"><label>TIME<input type="time" value={preference.timeLocal ?? ""} onChange={(event) => updatePreference(preference.type, { timeLocal: event.target.value || null })} /></label><label>CHANNEL<select value={preference.deliveryChannel} onChange={(event) => updatePreference(preference.type, { deliveryChannel: event.target.value as NotificationPreference["deliveryChannel"] })}><option value="web_push">Web push</option><option value="whatsapp">WhatsApp</option><option value="both">Both</option></select></label><button type="button" disabled={busy === preference.type || preference.daysOfWeek.length === 0} onClick={() => void savePreference(preference)}>SAVE</button></div>
            <div className="day-picker" aria-label={`${meta.label} days`}>{dayLabels.map((day, index) => { const value = index + 1; const active = preference.daysOfWeek.includes(value); return <button key={day.full} type="button" aria-label={day.full} aria-pressed={active} onClick={() => updatePreference(preference.type, { daysOfWeek: active ? preference.daysOfWeek.filter((item) => item !== value) : [...preference.daysOfWeek, value].sort() })}>{day.short}</button>; })}</div>
          </article>;
        })}
      </div>
    </section>
    <section className="push-foundation"><span>PUSH / FOUNDATION</span><p>Schedules persist now. Browser subscription and delivery remain inactive until a VAPID-backed sender and scheduler are configured.</p></section>
    {status && <p className="settings-status" role="status">{status}</p>}
  </div>;
}
