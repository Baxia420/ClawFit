import { isValidCalendarDate, type Routine, type ScheduleDay, type TrainingStats, type WeightHistory } from "@clawfit/health-core";
import { TrainingHub, type TrainingTab } from "../../components/TrainingHub";
import { healthApi, localDate, type Settings, type Workout } from "../../lib/api";
export const dynamic = "force-dynamic";
export default async function WorkoutsPage({ searchParams }: { searchParams: Promise<{ tab?: string; days?: string; date?: string }> }) {
  const query = await searchParams;
  const tab: TrainingTab = query.tab === "plans" || query.tab === "stats" || query.tab === "weight" ? query.tab : "train";
  const days = query.days === "7" ? 7 : query.days === "90" ? 90 : 30;
  try {
    const settings = await healthApi<Settings>("/v1/settings");
    const today = localDate(settings.timezone);
    const date = query.date && isValidCalendarDate(query.date) && query.date <= today ? query.date : today;
    let active: Workout | null = null, history: Workout[] = [], plans: { routines: Routine[]; schedule: ScheduleDay[] } = { routines: [], schedule: [] }, stats: TrainingStats | null = null, weight: WeightHistory | null = null;
    if (tab === "train") [active, history, plans] = await Promise.all([healthApi<Workout | null>("/v1/workouts/active"), healthApi<Workout[]>("/v1/workouts/history?limit=30"), healthApi<typeof plans>("/v1/training/plans")]);
    if (tab === "plans") plans = await healthApi<typeof plans>("/v1/training/plans");
    if (tab === "stats") stats = await healthApi<TrainingStats>(`/v1/training/stats?date=${date}&days=${days}`);
    if (tab === "weight") weight = await healthApi<WeightHistory>(`/v1/training/weight?date=${date}&days=${days}`);
    return <TrainingHub tab={tab} date={date} today={today} days={days} settings={settings} active={active} history={history} routines={plans.routines} schedule={plans.schedule} stats={stats} weight={weight} />;
  } catch {
    return <div className="page training-page"><header className="page-header compact"><div><span className="kicker">TRAINING</span><h1>Your next<br /><em>chapter.</em></h1></div></header><section className="training-card" role="alert"><h2>Training is temporarily unavailable</h2><p>Your records haven’t changed. Try again in a moment.</p><a className="training-button" href={`/workouts?tab=${tab}`}>Retry</a></section></div>;
  }
}
