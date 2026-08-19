import { AskLauncher } from "../components/AskLauncher";
import { MealList } from "../components/MealList";
import { Metric } from "../components/Metric";
import { healthApi, localDate, type Meal, type Settings, type Workout } from "../lib/api";

type Daily = { totals: { caloriesBest: number; caloriesLow: number; caloriesHigh: number; proteinG: number; carbsG: number; fatG: number }; meals: Meal[] };

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const settings = await healthApi<Settings>("/v1/settings");
  const timezone = settings.timezone;
  const date = localDate(timezone);
  const [daily, active] = await Promise.all([
    healthApi<Daily>(`/v1/nutrition/daily?date=${date}&timezone=${encodeURIComponent(timezone)}`),
    healthApi<Workout | null>("/v1/workouts/active"),
  ]);
  const totals = daily.totals;
  const target = settings.calorieTarget;
  const proteinTarget = settings.proteinTargetG;
  const remaining = Math.max(target - totals.caloriesBest, 0);
  const calorieProgress = Math.min((totals.caloriesBest / target) * 100, 100);
  const proteinProgress = Math.min((totals.proteinG / proteinTarget) * 100, 100);
  return (
    <div className="page">
      <header className="page-header"><div><span className="kicker">DAILY LOG / {date}</span><h1>Today’s<br /><em>signal.</em></h1></div><div className="header-code">TZ / {timezone}<br />TARGET / {target} KCAL</div></header>
      <section className="metric-grid" aria-label="Daily nutrition summary">
        <Metric label="ENERGY / BEST" value={Math.round(totals.caloriesBest)} unit="kcal" accent hint={`${remaining} kcal remaining`} />
        <Metric label="UNCERTAINTY" value={`${Math.round(totals.caloriesLow)}–${Math.round(totals.caloriesHigh)}`} unit="kcal" />
        <Metric label="PROTEIN" value={Math.round(totals.proteinG)} unit="g" hint={`${Math.max(Math.round(proteinTarget - totals.proteinG), 0)} g remaining`} />
        <Metric label="CARBS / FAT" value={`${Math.round(totals.carbsG)} / ${Math.round(totals.fatG)}`} unit="g" />
      </section>
      <section className="today-control" aria-label="Daily progress and quick actions">
        <div className="progress-block"><div><span>ENERGY / {Math.round(calorieProgress)}%</span><strong>{Math.round(totals.caloriesBest)} / {target}</strong></div><i><b style={{ width: `${calorieProgress}%` }} /></i></div>
        <div className="progress-block"><div><span>PROTEIN / {Math.round(proteinProgress)}%</span><strong>{Math.round(totals.proteinG)} / {proteinTarget} G</strong></div><i><b style={{ width: `${proteinProgress}%` }} /></i></div>
        <div className="quick-actions"><AskLauncher label="LOG A MEAL" prompt="I ate " /><AskLauncher label="ADD FOOD PHOTO" prompt="" className="quick-ask secondary" /><AskLauncher label="ASK CLAWFIT →" className="quick-ask dark" /></div>
      </section>
      <div className="split-grid">
        <section className="panel"><div className="panel-title"><span>01 / MEALS</span><strong>{daily.meals.length} entries</strong></div><MealList meals={daily.meals} timeZone={timezone} /></section>
        <section className="panel workout-now"><div className="panel-title"><span>02 / ACTIVE WORKOUT</span><strong>{active ? active.workout.status : "offline"}</strong></div>{active ? <><h2>{active.workout.name}</h2><div className="workout-stat"><strong>{active.setCount}</strong><span>SETS</span><strong>{Math.round(active.volumeKg).toLocaleString()}</strong><span>KG VOL</span></div><div className="exercise-tags">{active.exercises.map((exercise) => <span key={exercise.id}>{exercise.name} · {exercise.sets.length}</span>)}</div></> : <div className="empty"><strong>NO ACTIVE SESSION</strong><span>Ask ClawFit: “starting push”.</span></div>}</section>
      </div>
    </div>
  );
}
