import type { Meal } from "../lib/api";

export function MealList({ meals }: { meals: Meal[] }) {
  if (!meals.length) return <div className="empty"><strong>NO INTAKE LOGGED</strong><span>Message OpenClaw to estimate your first meal.</span></div>;
  return <div className="data-list">{meals.map((meal, index) => (
    <article className="meal-row" key={meal.id}>
      <span className="row-index">{String(index + 1).padStart(2, "0")}</span>
      <div><strong>{meal.label}</strong><small>{new Date(meal.occurredAt).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })} · {meal.confidence} confidence</small></div>
      <div className="meal-energy"><strong>{meal.caloriesBest}</strong><small>{meal.caloriesLow}–{meal.caloriesHigh} kcal</small></div>
    </article>
  ))}</div>;
}

