import { MealList } from "../../components/MealList";
import { Metric } from "../../components/Metric";
import { TrendChart } from "../../components/TrendChart";
import { healthApi, type Meal } from "../../lib/api";

type Trend = { day: string; calories_best: number; calories_low: number; calories_high: number; protein_g: number };

export default async function NutritionPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const params = await searchParams;
  const days = params.days === "7" ? 7 : 30;
  const [trendRaw, meals] = await Promise.all([healthApi<Trend[]>(`/v1/nutrition/trend?days=${days}`), healthApi<Meal[]>("/v1/meals/recent?limit=40")]);
  const trend = (trendRaw ?? []).map((row) => ({ day: new Date(row.day).toISOString().slice(0, 10), caloriesBest: Number(row.calories_best), caloriesLow: Number(row.calories_low), caloriesHigh: Number(row.calories_high), proteinG: Number(row.protein_g) }));
  const calorieAverage = trend.length ? Math.round(trend.reduce((sum, row) => sum + row.caloriesBest, 0) / trend.length) : 0;
  const proteinAverage = trend.length ? Math.round(trend.reduce((sum, row) => sum + row.proteinG, 0) / trend.length) : 0;
  return <div className="page"><header className="page-header compact"><div><span className="kicker">ROLLING INTAKE / {days} DAYS</span><h1>Nutrition<br /><em>history.</em></h1></div><div className="range-switch"><a className={days === 7 ? "active" : ""} href="/nutrition?days=7">07D</a><a className={days === 30 ? "active" : ""} href="/nutrition?days=30">30D</a></div></header>
    <section className="metric-grid two"><Metric label="AVG ENERGY" value={calorieAverage} unit="kcal/day" accent /><Metric label="AVG PROTEIN" value={proteinAverage} unit="g/day" /></section>
    <section className="panel chart-panel"><div className="panel-title"><span>01 / CALORIE BAND</span><strong>best estimate</strong></div>{trend.length ? <TrendChart data={trend} /> : <div className="empty"><strong>NO TREND YET</strong><span>Daily points appear after meals are logged.</span></div>}</section>
    <section className="panel chart-panel"><div className="panel-title"><span>02 / PROTEIN</span><strong>grams per day</strong></div>{trend.length ? <TrendChart data={trend} mode="protein" /> : <div className="empty"><strong>NO TREND YET</strong></div>}</section>
    <section className="panel"><div className="panel-title"><span>03 / MEAL ARCHIVE</span><strong>{meals?.length ?? 0} recent</strong></div><MealList meals={meals ?? []} /></section>
  </div>;
}

