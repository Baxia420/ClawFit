import { SettingsForm } from "../../components/SettingsForm";
import { healthApi, type NotificationPreference, type Settings } from "../../lib/api";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let settings: Settings | null = null;
  let preferences: NotificationPreference[] = [];
  let apiError: string | null = null;

  try {
    const [s, p] = await Promise.all([
      healthApi<Settings>("/v1/settings"),
      healthApi<NotificationPreference[]>("/v1/notification-preferences"),
    ]);
    settings = s;
    preferences = p;
  } catch (err) {
    apiError = err instanceof Error ? err.message : "Health API is currently unreachable";
  }

  if (apiError || !settings) {
    return (
      <div className="page service-error">
        <header className="page-header compact">
          <div>
            <span className="kicker">SERVICE STATUS</span>
            <h1>Rules,<br /><em>not noise.</em></h1>
          </div>
        </header>
        <section className="panel" role="alert">
          <div className="panel-title"><span>SERVICE NOTICE</span><strong>temporarily unavailable</strong></div>
          <div className="service-error-body">
            <p>Unable to load your settings right now. Please check your connection or retry.</p>
            <a href="/settings" className="quick-ask dark" style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}>RETRY CONNECTION</a>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page settings-page">
      <header className="page-header compact">
        <div>
          <span className="kicker">PERSONAL CONFIG / PRIVATE</span>
          <h1>Rules,<br /><em>not noise.</em></h1>
        </div>
        <div className="header-code">CHANNELS / STAGED<br />SCHEDULE / PERSISTED</div>
      </header>
      <SettingsForm initialSettings={settings} savedPreferences={preferences} />
    </div>
  );
}
