import { formatLocalTime, formatLocalDate, type Meal } from "../lib/api";
import { historicalTimeKnown } from "@clawfit/health-core";

export function MealList({ meals, timeZone }: { meals: Meal[]; timeZone: string }) {
  if (!meals.length) return <div className="empty"><strong>NO INTAKE LOGGED</strong><span>Open Ask ClawFit to estimate your first meal.</span></div>;
  return <div className="data-list">{meals.map((meal, index) => (
    <article className="meal-row" key={meal.id}>
      <span className="row-index">{String(index + 1).padStart(2, "0")}</span>
      <div><strong>{meal.label}</strong><small>{formatLocalDate(meal.occurredAt, timeZone)} · {historicalTimeKnown(meal.rawUserText) ? formatLocalTime(meal.occurredAt, timeZone) : "Time unknown"} · {meal.confidence} estimate confidence</small>
        <small>Protein {macro(meal.proteinG)} · Carbs {macro(meal.carbsG)} · Fat {macro(meal.fatG)}</small></div>
      <div className="meal-energy"><strong>{meal.caloriesBest ?? "Unknown"}</strong><small>{meal.caloriesLow === null || meal.caloriesHigh === null ? "Unknown calories" : `${meal.caloriesLow}–${meal.caloriesHigh} kcal`}</small></div>
    </article>
  ))}</div>;
}

function macro(value: number | null): string { return value === null ? "unknown" : `${Math.round(value * 10) / 10} g`; }
