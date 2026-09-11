import Link from "next/link";
import { formatLocalDate, healthApi, type Settings, type Workout } from "../../lib/api";

export const dynamic = "force-dynamic";

export default async function WorkoutsPage() {
  let workouts: Workout[] = [];
  let settings: Settings | null = null;
  let apiError: string | null = null;

  try {
    const [w, s] = await Promise.all([
      healthApi<Workout[]>("/v1/workouts/history?limit=30"),
      healthApi<Settings>("/v1/settings"),
    ]);
    workouts = w;
    settings = s;
  } catch (err) {
    apiError = err instanceof Error ? err.message : "Health API is currently unreachable";
  }

  if (apiError || !settings) {
    return (
      <div className="page service-error">
        <header className="page-header compact">
          <div>
            <span className="kicker">SERVICE STATUS</span>
            <h1>Work<br /><em>performed.</em></h1>
          </div>
        </header>
        <section className="panel" role="alert">
          <div className="panel-title"><span>SERVICE NOTICE</span><strong>temporarily unavailable</strong></div>
          <div className="service-error-body">
            <p>Unable to load your workout history right now. Please check your connection or retry.</p>
            <a href="/workouts" className="quick-ask dark" style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}>RETRY CONNECTION</a>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header compact">
        <div>
          <span className="kicker">STRENGTH ARCHIVE</span>
          <h1>Work<br /><em>performed.</em></h1>
        </div>
        <div className="header-code">VOLUME / DETERMINISTIC<br />1RM / EPLEY</div>
      </header>
      <section className="panel">
        <div className="panel-title">
          <span>01 / RECENT SESSIONS</span>
          <strong>{workouts.length} workouts</strong>
        </div>
        {workouts.length ? (
          <div className="workout-list">
            {workouts.map((item) => (
              <article key={item.workout.id}>
                <div className="workout-head">
                  <span>{formatLocalDate(item.workout.startedAt, settings.timezone)}</span>
                  <h2>{item.workout.name}</h2>
                  <strong>{Math.round(item.volumeKg).toLocaleString()} <small>kg</small></strong>
                </div>
                <div className="set-table">
                  {item.exercises.map((exercise) => (
                    <div className="exercise-line" key={exercise.id}>
                      <Link href={`/exercises/${encodeURIComponent(exercise.name)}`}>{exercise.name}</Link>
                      <div>
                        {exercise.sets.map((set) => (
                          <span key={set.id}>{set.weightKg ?? "BW"} × {set.reps}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <footer>{item.setCount} total sets <i /> {item.workout.status}</footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">
            <strong>NO WORKOUTS LOGGED</strong>
            <span>Open Ask ClawFit and say “starting push”.</span>
          </div>
        )}
      </section>
    </div>
  );
}
