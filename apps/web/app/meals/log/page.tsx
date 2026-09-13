import { MealLogFlow } from "../../../components/MealLogFlow";
import { healthApi, type Settings } from "../../../lib/api";
import { auth } from "../../../auth";

export const dynamic = "force-dynamic";

export default async function MealLogPage() {
  const session = await auth();
  let timezone = "Asia/Kuala_Lumpur";

  if (session?.user?.id) {
    try {
      const settings = await healthApi<Settings>("/v1/settings");
      if (settings?.timezone) {
        timezone = settings.timezone;
      }
    } catch {
      // Default timezone used if settings cannot be reached
    }
  }

  return (
    <div className="page meal-log-page">
      <header className="page-header compact">
        <div>
          <span className="kicker">NUTRITION INTAKE &middot; DIRECT RECORD</span>
          <h1>
            Log a<br />
            <em>meal.</em>
          </h1>
        </div>
        <div className="header-code">
          INPUT: TEXT / PHOTO / MANUAL
          <br />
          CONFIRMATION REQUIRED
        </div>
      </header>

      <MealLogFlow timezone={timezone} />
    </div>
  );
}
