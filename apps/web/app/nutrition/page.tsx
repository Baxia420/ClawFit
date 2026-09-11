import { MealList } from "../../components/MealList";
import { Metric } from "../../components/Metric";
import { TrendChart } from "../../components/TrendChart";
import { healthApi, type Meal, type Settings } from "../../lib/api";
import { calculateTrendSummary } from "../../lib/dashboard";

type Trend = { day: string; calories_best: number; calories_low: number; calories_high: number; protein_g: number };

export const dynamic = "force-dynamic";

export default async function NutritionPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const params = await searchParams;
  const days = params.days === "7" ? 7 : 30;

  let trendRaw: Trend[] = [];
  let meals: Meal[] = [];
  let settings: Settings | null = null;
  let apiError: string | null = null;

  try {
    const s = await healthApi<Settings>("/v1/settings");
    settings = s;
    const [t, m] = await Promise.all([
      healthApi<Trend[]>(`/v1/nutrition/trend?days=${days}&timezone=${encodeURIComponent(s.timezone)}`),
      healthApi<Meal[]>("/v1/meals/recent?limit=40"),
    ]);
    trendRaw = t;
    meals = m;
  } catch (err) {
    apiError = err instanceof Error ? err.message : "Service unavailable";
  }

  if (apiError || !settings) {
    return (
      <div className="page service-error">
        <header className="page-header compact">
          <div>
            <span className="kicker">SERVICE STATUS</span>
            <h1>Nutrition<br /><em>history.</em></h1>
          </div>
        </header>
        <section className="panel" role="alert">
          <div className="panel-title"><span>SERVICE NOTICE</span><strong>temporarily unavailable</strong></div>
          <div className="service-error-body">
            <p>Unable to load your nutrition history right now. Please check your connection or retry.</p>
            <a href="/nutrition" className="quick-ask dark" style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}>RETRY CONNECTION</a>
          </div>
        </section>
      </div>
    );
  }

  const trend = trendRaw.map((row) => ({
    day: String(row.day).slice(0, 10),
    caloriesBest: Number(row.calories_best),
    caloriesLow: Number(row.calories_low),
    caloriesHigh: Number(row.calories_high),
    proteinG: Number(row.protein_g),
  }));
  const summary = calculateTrendSummary(trend, days, settings);

  return (
    <div className="page">
      <header className="page-header compact">
        <div>
          <span className="kicker">ROLLING INTAKE / {days} DAYS</span>
          <h1>Nutrition<br /><em>history.</em></h1>
        </div>
        <div className="range-switch">
          <a className={days === 7 ? "active" : ""} href="/nutrition?days=7">07D</a>
          <a className={days === 30 ? "active" : ""} href="/nutrition?days=30">30D</a>
        </div>
      </header>
      <section className="metric-grid two">
        <Metric
          label="AVG ENERGY (LOGGED DAYS)"
          value={summary.calorieAverage}
          unit="kcal/day"
          accent
          hint={summary.calorieHint}
        />
        <Metric
          label="AVG PROTEIN"
          value={summary.proteinAverage}
          unit="g/day"
          hint={summary.proteinHint}
        />
      </section>
      <section className="panel chart-panel">
        <div className="panel-title">
          <span>01 / CALORIE BAND</span>
          <strong>best estimate</strong>
        </div>
        {trend.length ? <TrendChart data={trend} /> : <div className="empty"><strong>NO TREND YET</strong><span>Daily points appear after meals are logged.</span></div>}
      </section>
      <section className="panel chart-panel">
        <div className="panel-title">
          <span>02 / PROTEIN</span>
          <strong>grams per day</strong>
        </div>
        {trend.length ? <TrendChart data={trend} mode="protein" /> : <div className="empty"><strong>NO TREND YET</strong></div>}
      </section>
      <section className="panel">
        <div className="panel-title">
          <span>03 / MEAL ARCHIVE</span>
          <strong>{meals.length} recent</strong>
        </div>
        <MealList meals={meals} timeZone={settings.timezone} />
      </section>
    </div>
  );
}
