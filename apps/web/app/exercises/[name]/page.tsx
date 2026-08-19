import { Metric } from "../../../components/Metric";
import { TrendChart } from "../../../components/TrendChart";
import { formatLocalDate, healthApi, type Settings } from "../../../lib/api";

type HistorySet = { id: string; occurredAt: string; weightKg: number | null; reps: number; estimatedOneRepMax: number | null; workoutName: string };

export default async function ExercisePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const exerciseName = decodeURIComponent(name);
  const [rows, settings] = await Promise.all([
    healthApi<HistorySet[]>(`/v1/exercises/history?name=${encodeURIComponent(exerciseName)}&limit=200`),
    healthApi<Settings>("/v1/settings"),
  ]);
  const weighted = rows.filter((row) => row.weightKg !== null);
  const bestWeight = weighted.length ? Math.max(...weighted.map((row) => row.weightKg!)) : 0;
  const bestE1rm = rows.length ? Math.max(...rows.map((row) => row.estimatedOneRepMax ?? 0)) : 0;
  const chart = [...rows].reverse().map((row) => ({ day: row.occurredAt.slice(0, 10), ...(row.estimatedOneRepMax === null ? {} : { estimatedOneRepMax: row.estimatedOneRepMax }) }));
  return <div className="page"><header className="page-header compact"><div><span className="kicker">EXERCISE HISTORY</span><h1>{exerciseName}</h1></div><div className="header-code">SETS / {rows.length}<br />METHOD / EPLEY</div></header>
    <section className="metric-grid two"><Metric label="HEAVIEST" value={bestWeight} unit="kg" accent /><Metric label="BEST EST. 1RM" value={bestE1rm} unit="kg" /></section>
    <section className="panel chart-panel"><div className="panel-title"><span>01 / ESTIMATED 1RM</span><strong>trend</strong></div>{chart.length ? <TrendChart data={chart} mode="e1rm" /> : <div className="empty"><strong>NO SET HISTORY</strong></div>}</section>
    <section className="panel"><div className="panel-title"><span>02 / SET LOG</span><strong>most recent first</strong></div><div className="data-list">{rows.map((row, index) => <article className="meal-row" key={row.id}><span className="row-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{row.workoutName}</strong><small>{formatLocalDate(row.occurredAt, settings.timezone)}</small></div><div className="meal-energy"><strong>{row.weightKg ?? "BW"} × {row.reps}</strong><small>{row.estimatedOneRepMax ? `e1RM ${row.estimatedOneRepMax} kg` : "bodyweight"}</small></div></article>)}</div></section>
  </div>;
}
