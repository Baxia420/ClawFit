import { SettingsForm } from "../../components/SettingsForm";
import { healthApi, type NotificationPreference, type Settings } from "../../lib/api";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, preferences] = await Promise.all([
    healthApi<Settings>("/v1/settings"),
    healthApi<NotificationPreference[]>("/v1/notification-preferences"),
  ]);
  return <div className="page settings-page"><header className="page-header compact"><div><span className="kicker">PERSONAL CONFIG / PRIVATE</span><h1>Rules,<br /><em>not noise.</em></h1></div><div className="header-code">CHANNELS / STAGED<br />SCHEDULE / PERSISTED</div></header><SettingsForm initialSettings={settings} savedPreferences={preferences} /></div>;
}
