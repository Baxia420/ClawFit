import { formatLocalTime, type Meal } from "../lib/api";

export function MealList({ meals, timeZone }: { meals: Meal[]; timeZone: string }) {
  if (!meals.length) return <div className="empty"><strong>NO INTAKE LOGGED</strong><span>Open Ask ClawFit to estimate your first meal.</span></div>;
  return <div className="data-list">{meals.map((meal, index) => (
    <article className="meal-row" key={meal.id}>
      <span className="row-index">{String(index + 1).padStart(2, "0")}</span>
      <div><strong>{meal.label}</strong><small>{formatLocalTime(meal.occurredAt, timeZone)} · {meal.confidence} confidence</small></div>
      <div className="meal-energy"><strong>{meal.caloriesBest}</strong><small>{meal.caloriesLow}–{meal.caloriesHigh} kcal</small></div>
    </article>
  ))}</div>;
}
