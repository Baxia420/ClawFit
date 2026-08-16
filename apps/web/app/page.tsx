import { MealList } from "../components/MealList";
import { Metric } from "../components/Metric";
import { healthApi, localDate, type Meal, type Workout } from "../lib/api";

type Daily = { totals: { caloriesBest: number; caloriesLow: number; caloriesHigh: number; proteinG: number; carbsG: number; fatG: number }; meals: Meal[] };

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const date = localDate();
  const timezone = process.env.APP_TIMEZONE ?? "Asia/Kuala_Lumpur";
  const [daily, active] = await Promise.all([
    healthApi<Daily>(`/v1/nutrition/daily?date=${date}&timezone=${encodeURIComponent(timezone)}`),
    healthApi<Workout>("/v1/workouts/active"),
  ]);
  const totals = daily?.totals ?? { caloriesBest: 0, caloriesLow: 0, caloriesHigh: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  const target = Number(process.env.CALORIE_TARGET ?? 2200);
  const remaining = Math.max(target - totals.caloriesBest, 0);
  return (
    <div className="page">
      <header className="page-header"><div><span className="kicker">DAILY LOG / {date}</span><h1>Today’s<br /><em>signal.</em></h1></div><div className="header-code">TZ / {timezone}<br />TARGET / {target} KCAL</div></header>
      <section className="metric-grid" aria-label="Daily nutrition summary">
        <Metric label="ENERGY / BEST" value={Math.round(totals.caloriesBest)} unit="kcal" accent hint={`${remaining} kcal remaining`} />
        <Metric label="UNCERTAINTY" value={`${Math.round(totals.caloriesLow)}–${Math.round(totals.caloriesHigh)}`} unit="kcal" />
        <Metric label="PROTEIN" value={Math.round(totals.proteinG)} unit="g" />
        <Metric label="CARBS / FAT" value={`${Math.round(totals.carbsG)} / ${Math.round(totals.fatG)}`} unit="g" />
      </section>
      <div className="split-grid">
        <section className="panel"><div className="panel-title"><span>01 / MEALS</span><strong>{daily?.meals.length ?? 0} entries</strong></div><MealList meals={daily?.meals ?? []} /></section>
        <section className="panel workout-now"><div className="panel-title"><span>02 / ACTIVE WORKOUT</span><strong>{active ? active.workout.status : "offline"}</strong></div>{active ? <><h2>{active.workout.name}</h2><div className="workout-stat"><strong>{active.setCount}</strong><span>SETS</span><strong>{Math.round(active.volumeKg).toLocaleString()}</strong><span>KG VOL</span></div><div className="exercise-tags">{active.exercises.map((exercise) => <span key={exercise.id}>{exercise.name} · {exercise.sets.length}</span>)}</div></> : <div className="empty"><strong>NO ACTIVE SESSION</strong><span>Say “starting push” to OpenClaw.</span></div>}</section>
      </div>
    </div>
  );
}
