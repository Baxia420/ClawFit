import { formatLocalDate } from "../lib/dates";
import { nutritionChartGaps, type ChartPoint } from "../lib/nutrition-chart";

function partialValue(value: number | undefined, missing: number | undefined, mealCount: number | undefined, unit: string) {
  if (value === undefined || missing === undefined || missing === mealCount) return null;
  return `${Math.round(value * 10) / 10} ${unit} known; ${missing} ${missing === 1 ? "meal" : "meals"} missing values.`;
}

export function NutritionChartGaps({ data }: { data: readonly ChartPoint[] }) {
  const gaps = nutritionChartGaps(data);
  if (!gaps.length) return null;
  return <details className="panel nutrition-gaps">
    <summary className="panel-title"><span>03 / CHART GAPS</span><strong>{gaps.length} dates · view details</strong></summary>
    <p className="coverage-note">Unlogged days and incomplete totals leave gaps in the lines. Missing ranges leave gaps in the green band. Known subtotals are partial, and are excluded from daily averages.</p>
    <ul>
      {gaps.map(({ point, issues }) => <li key={point.day}>
        <div className="gap-date"><time dateTime={point.day}>{formatLocalDate(`${point.day}T12:00:00Z`, "UTC")}</time>{point.logged !== false && <a href={`/nutrition?date=${point.day}&days=7`}>View meals</a>}</div>
        <div><div className="gap-issues">{issues.map(issue => <span key={issue}>{issue}</span>)}</div>
          {point.logged !== false && <>
            {point.caloriesBest == null && <p>{partialValue(point.knownCalories, point.missingCalories, point.mealCount, "kcal") ?? "Calorie total is unknown."}</p>}
            {point.proteinG == null && <p>{partialValue(point.knownProteinG, point.missingProtein, point.mealCount, "g protein") ?? "Protein total is unknown."}</p>}
          </>}
        </div>
      </li>)}
    </ul>
  </details>;
}
