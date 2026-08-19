import Link from "next/link";
import { formatLocalDate, healthApi, type Settings, type Workout } from "../../lib/api";

export const dynamic = "force-dynamic";

export default async function WorkoutsPage() {
  const [workouts, settings] = await Promise.all([healthApi<Workout[]>("/v1/workouts/history?limit=30"), healthApi<Settings>("/v1/settings")]);
  return <div className="page"><header className="page-header compact"><div><span className="kicker">STRENGTH ARCHIVE</span><h1>Work<br /><em>performed.</em></h1></div><div className="header-code">VOLUME / DETERMINISTIC<br />1RM / EPLEY</div></header>
    <section className="panel"><div className="panel-title"><span>01 / RECENT SESSIONS</span><strong>{workouts.length} workouts</strong></div>
      {workouts.length ? <div className="workout-list">{workouts.map((item) => <article key={item.workout.id}><div className="workout-head"><span>{formatLocalDate(item.workout.startedAt, settings.timezone)}</span><h2>{item.workout.name}</h2><strong>{Math.round(item.volumeKg).toLocaleString()} <small>kg</small></strong></div><div className="set-table">{item.exercises.map((exercise) => <div className="exercise-line" key={exercise.id}><Link href={`/exercises/${encodeURIComponent(exercise.name)}`}>{exercise.name}</Link><div>{exercise.sets.map((set) => <span key={set.id}>{set.weightKg ?? "BW"} × {set.reps}</span>)}</div></div>)}</div><footer>{item.setCount} total sets <i /> {item.workout.status}</footer></article>)}</div> : <div className="empty"><strong>NO WORKOUTS LOGGED</strong><span>Open Ask ClawFit and say “starting push”.</span></div>}
    </section>
  </div>;
}
