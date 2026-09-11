import { AskLauncher } from "../components/AskLauncher";
import { MealList } from "../components/MealList";
import { Metric } from "../components/Metric";
import { healthApi, localDate, type Meal, type Settings, type Workout } from "../lib/api";
import { auth } from "../auth";
import { calculateDailyProgress } from "../lib/dashboard";

type Daily = { totals: { caloriesBest: number; caloriesLow: number; caloriesHigh: number; proteinG: number; carbsG: number; fatG: number }; meals: Meal[] };

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const session = await auth();
  const userName = session?.user?.displayName ?? session?.user?.name;
  const headerName = userName ? `${userName}${userName.endsWith("s") ? "’" : "’s"}` : "Today’s";

  let settings: Settings | null = null;
  let daily: Daily | null = null;
  let active: Workout | null = null;
  let apiError: string | null = null;

  try {
    const s = await healthApi<Settings>("/v1/settings");
    settings = s;
    const timezone = s.timezone;
    const date = localDate(timezone);
    const [d, a] = await Promise.all([
      healthApi<Daily>(`/v1/nutrition/daily?date=${date}&timezone=${encodeURIComponent(timezone)}`),
      healthApi<Workout | null>("/v1/workouts/active"),
    ]);
    daily = d;
    active = a;
  } catch (err) {
    apiError = err instanceof Error ? err.message : "Service unavailable";
  }

  if (apiError || !settings || !daily) {
    return (
      <div className="page service-error">
        <header className="page-header compact">
          <div>
            <span className="kicker">SERVICE STATUS</span>
            <h1>{headerName}<br /><em>signal.</em></h1>
          </div>
        </header>
        <section className="panel" role="alert">
          <div className="panel-title"><span>SERVICE NOTICE</span><strong>temporarily unavailable</strong></div>
          <div className="service-error-body">
            <p>Unable to load your health data right now. Please check your connection or retry.</p>
            <a href="/" className="quick-ask dark" style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}>RETRY CONNECTION</a>
          </div>
        </section>
      </div>
    );
  }

  const timezone = settings.timezone;
  const date = localDate(timezone);
  const totals = daily.totals;
  const target = settings.calorieTarget;
  const proteinTarget = settings.proteinTargetG;
  const progress = calculateDailyProgress(totals, settings);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="kicker">DAILY LOG / {date}</span>
          <h1>{headerName}<br /><em>signal.</em></h1>
        </div>
        <div className="header-code">TARGET / {target} KCAL<br />PROTEIN / {proteinTarget}G</div>
      </header>
      <section className="metric-grid" aria-label="Daily nutrition summary">
        <Metric label="ENERGY / BEST" value={Math.round(totals.caloriesBest)} unit="kcal" accent hint={progress.calorieHint} />
        <Metric label="UNCERTAINTY" value={`${Math.round(totals.caloriesLow)}–${Math.round(totals.caloriesHigh)}`} unit="kcal" />
        <Metric label="PROTEIN" value={Math.round(totals.proteinG)} unit="g" hint={progress.proteinHint} />
        <Metric label="CARBS / FAT" value={`${Math.round(totals.carbsG)} / ${Math.round(totals.fatG)}`} unit="g" />
      </section>
      <section className="today-control" aria-label="Daily progress and quick actions">
        <div className="progress-block">
          <div>
            <span>ENERGY / {progress.caloriePct}%</span>
            <strong>{Math.round(totals.caloriesBest)} / {target}</strong>
          </div>
          <i><b style={{ width: `${progress.calorieBarWidth}%` }} /></i>
        </div>
        <div className="progress-block">
          <div>
            <span>PROTEIN / {progress.proteinPct}%</span>
            <strong>{Math.round(totals.proteinG)} / {proteinTarget} G</strong>
          </div>
          <i><b style={{ width: `${progress.proteinBarWidth}%` }} /></i>
        </div>
        <div className="quick-actions">
          <AskLauncher label="LOG A MEAL" prompt="I ate " />
          <AskLauncher label="ADD FOOD PHOTO" prompt="" className="quick-ask secondary" />
          <AskLauncher label="ASK CLAWFIT →" className="quick-ask dark" />
        </div>
      </section>
      <div className="split-grid">
        <section className="panel">
          <div className="panel-title">
            <span>01 / MEALS</span>
            <strong>{daily.meals.length} entries</strong>
          </div>
          <MealList meals={daily.meals} timeZone={timezone} />
        </section>
        <section className="panel workout-now">
          <div className="panel-title">
            <span>02 / ACTIVE WORKOUT</span>
            <strong>{active ? active.workout.status : "offline"}</strong>
          </div>
          {active ? (
            <>
              <h2>{active.workout.name}</h2>
              <div className="workout-stat">
                <strong>{active.setCount}</strong>
                <span>SETS</span>
                <strong>{Math.round(active.volumeKg).toLocaleString()}</strong>
                <span>KG VOL</span>
              </div>
              <div className="exercise-tags">
                {active.exercises.map((exercise) => (
                  <span key={exercise.id}>{exercise.name} · {exercise.sets.length}</span>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">
              <strong>NO ACTIVE SESSION</strong>
              <span>Ask ClawFit: “starting push”.</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
