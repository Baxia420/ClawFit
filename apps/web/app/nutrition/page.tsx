import { isValidCalendarDate } from "@clawfit/health-core";
import { MealList } from "../../components/MealList";
import { Metric } from "../../components/Metric";
import { TrendChart } from "../../components/TrendChart";
import { NutritionChartGaps } from "../../components/NutritionChartGaps";
import { healthApi, type Meal, type Settings, localDate } from "../../lib/api";
import { calculateTrendSummary, calendarTrend } from "../../lib/dashboard";

type Trend = { day: string; calories_best: number | null; calories_low: number | null; calories_high: number | null; protein_g: number | null; meal_count?: number; known_calories?: number; known_protein?: number; missing_calories?: number; missing_protein?: number };

export const dynamic = "force-dynamic";

export default async function NutritionPage({ searchParams }: { searchParams: Promise<{ days?: string; date?: string; search?: string; offset?: string }> }) {
  const params = await searchParams;
  const days = params.days === "7" ? 7 : 30;

  let trendRaw: Trend[] = [];
  let meals: Meal[] = [];
  let settings: Settings | null = null;
  let selectedDate = "";
  let totalMeals = 0;
  const search = (params.search ?? "").trim().slice(0, 200);
  const offset = /^\d+$/.test(params.offset ?? "") ? Math.min(Number(params.offset), 100000) : 0;
  let apiError: string | null = null;

  try {
    const s = await healthApi<Settings>("/v1/settings");
    settings = s;
    selectedDate = params.date && isValidCalendarDate(params.date) ? params.date : localDate(s.timezone);
    const [t, m] = await Promise.all([
      healthApi<Trend[]>(`/v1/nutrition/trend?date=${selectedDate}&days=${days}&timezone=${encodeURIComponent(s.timezone)}`),
      healthApi<{ meals: Meal[]; total: number }>(`/v1/meals/history?date=${selectedDate}&days=${days}&timezone=${encodeURIComponent(s.timezone)}&limit=40&offset=${offset}&search=${encodeURIComponent(search)}`),
    ]);
    trendRaw = t;
    meals = m.meals;
    totalMeals = m.total;
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
    caloriesBest: row.calories_best === null ? null : Number(row.calories_best),
    caloriesLow: row.calories_low === null ? null : Number(row.calories_low),
    caloriesHigh: row.calories_high === null ? null : Number(row.calories_high),
    proteinG: row.protein_g === null ? null : Number(row.protein_g),
    logged: true, mealCount: row.meal_count,
    knownCalories: row.known_calories, knownProteinG: row.known_protein,
    missingCalories: row.missing_calories, missingProtein: row.missing_protein,
  }));
  const summary = calculateTrendSummary(trend, days, settings);
  const chartData = calendarTrend(trend, selectedDate, days);
  const historyUrl = (duration: number, pageOffset = 0) => `/nutrition?${new URLSearchParams({ days: String(duration), date: selectedDate, search, offset: String(pageOffset) })}`;
  const startDate = chartData[0]?.day ?? selectedDate;

  return (
    <div className="page">
      <header className="page-header compact">
        <div>
          <span className="kicker">ROLLING INTAKE / {startDate} TO {selectedDate}</span>
          <h1>Nutrition<br /><em>history.</em></h1>
        </div>
        <div className="range-switch">
          <a className={days === 7 ? "active" : ""} href={historyUrl(7)}>07D</a>
          <a className={days === 30 ? "active" : ""} href={historyUrl(30)}>30D</a>
        </div>
      </header>
      <form className="archive-controls" method="GET">
        <input type="hidden" name="days" value={days} />
        <label>Through <input type="date" name="date" defaultValue={selectedDate} max={localDate(settings.timezone)} /></label>
        <label>Find a meal <input type="search" name="search" defaultValue={search} maxLength={200} /></label>
        <button type="submit">View</button>
      </form>
      <p className="coverage-note">{summary.activeDays} of {days} days logged. Each average uses days whose logged meals have complete values for that nutrient; incomplete days are excluded. This does not establish that every meal eaten was logged. Comparisons use current goals.</p>
      <section className="metric-grid two">
        <Metric
          label="AVG ENERGY (COMPLETE LOGGED DAYS)"
          value={summary.calorieAverage ?? "—"}
          unit="kcal/day"
          accent
          hint={summary.calorieHint}
        />
        <Metric
          label="AVG PROTEIN (COMPLETE LOGGED DAYS)"
          value={summary.proteinAverage ?? "—"}
          unit="g/day"
          hint={summary.proteinHint}
        />
      </section>
      <section className="panel chart-panel">
        <div className="panel-title">
          <span>01 / CALORIE BAND</span>
          <strong>best estimate</strong>
        </div>
        {trend.length ? <TrendChart data={chartData} /> : <div className="empty"><strong>NO TREND YET</strong><span>Daily points appear after meals are logged.</span></div>}
        {trend.length > 0 && <p className="chart-legend"><span className="legend-estimate">Best estimate</span><span className="legend-range">Calorie range</span><span>Gaps: see dates below</span></p>}
      </section>
      <section className="panel chart-panel">
        <div className="panel-title">
          <span>02 / PROTEIN</span>
          <strong>grams per day</strong>
        </div>
        {trend.length ? <TrendChart data={chartData} mode="protein" /> : <div className="empty"><strong>NO TREND YET</strong></div>}
      </section>
      <NutritionChartGaps data={chartData} />
      <section className="panel">
        <div className="panel-title">
          <span>04 / MEAL ARCHIVE</span>
          <strong>{totalMeals} matching meals</strong>
        </div>
        {meals.length ? <MealList meals={meals} timeZone={settings.timezone} /> : <div className="empty"><strong>No matching meals</strong><span>Try another date range or search.</span></div>}
        <nav className="archive-controls" aria-label="Meal archive pages">
          {offset > 0 && <a href={historyUrl(days, Math.max(0, offset - 40))}>Previous</a>}
          <span>{meals.length ? offset + 1 : 0}–{offset + meals.length} of {totalMeals}</span>
          {offset + meals.length < totalMeals && <a href={historyUrl(days, offset + 40)}>Next</a>}
        </nav>
      </section>
    </div>
  );
}
