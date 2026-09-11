import type { TogetherMemberProgress } from "../lib/api";
import { formatLocalTime } from "../lib/api";
import { calculateTogetherMemberProgress } from "../lib/dashboard";

interface TogetherMemberPanelProps {
  member: TogetherMemberProgress;
  timeZone: string;
  trendDays: number;
}

export function TogetherMemberPanel({ member, timeZone, trendDays }: TogetherMemberPanelProps) {
  const calc = calculateTogetherMemberProgress(
    member.goals.calorieTarget,
    member.daily.calories,
    member.goals.proteinTargetG,
    member.daily.proteinG,
    member.trend,
  );

  return (
    <div className="together-member-card">
      <header className="together-member-header">
        <div className="together-member-identity">
          <span className="member-avatar" aria-hidden="true">
            {member.displayName.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <h2 className="together-member-name">
              {member.displayName}
              {member.isCaller && <span className="together-badge-you">You</span>}
            </h2>
            <small className="together-member-sub">
              {member.daily.mealCount} {member.daily.mealCount === 1 ? "meal" : "meals"} logged
            </small>
          </div>
        </div>
      </header>

      {/* Daily Progress Section */}
      <section className="together-progress-section" aria-label={`Nutrition progress for ${member.displayName}`}>
        <div className="together-metric-box">
          <div className="together-metric-row">
            <span className="eyebrow">Calories</span>
            <strong>
              {calc.caloriesConsumed} <small>/ {calc.calorieTarget} kcal</small>
            </strong>
          </div>
          <div
            className="together-bar-track"
            role="progressbar"
            aria-valuenow={calc.calorieAriaValueNow}
            aria-valuemin={calc.calorieAriaValueMin}
            aria-valuemax={calc.calorieAriaValueMax}
            aria-valuetext={calc.calorieAccessibleText}
          >
            <div className="together-bar-fill calories" style={{ width: `${calc.calorieBoundedBar}%` }} />
          </div>
          <p className="together-metric-note">
            {calc.calorieDiff > 0 ? (
              <span><strong>{calc.calorieDiff} kcal</strong> remaining</span>
            ) : calc.calorieDiff === 0 ? (
              <span>Target reached</span>
            ) : (
              <span><strong>{Math.abs(calc.calorieDiff)} kcal</strong> over target</span>
            )}
          </p>
        </div>

        <div className="together-metric-box">
          <div className="together-metric-row">
            <span className="eyebrow">Protein</span>
            <strong>
              {calc.proteinConsumed} <small>/ {calc.proteinTarget} g</small>
            </strong>
          </div>
          <div
            className="together-bar-track"
            role="progressbar"
            aria-valuenow={calc.proteinAriaValueNow}
            aria-valuemin={calc.proteinAriaValueMin}
            aria-valuemax={calc.proteinAriaValueMax}
            aria-valuetext={calc.proteinAccessibleText}
          >
            <div className="together-bar-fill protein" style={{ width: `${calc.proteinBoundedBar}%` }} />
          </div>
          <p className="together-metric-note">
            {calc.proteinDiff > 0 ? (
              <span><strong>{calc.proteinDiff} g</strong> remaining</span>
            ) : (
              <span>Target met ({calc.proteinConsumed} g)</span>
            )}
          </p>
        </div>
      </section>

      {/* Confirmed Meals Section */}
      <section className="together-feed-section" aria-label={`Confirmed meals for ${member.displayName}`}>
        <h3 className="together-feed-title">
          <span>Confirmed Meals</span>
          <small>{member.daily.meals.length}</small>
        </h3>
        {member.daily.meals.length === 0 ? (
          <div className="together-empty-feed">
            <p>No meals logged for this day.</p>
          </div>
        ) : (
          <ul className="together-meals-list">
            {member.daily.meals.map((meal) => (
              <li key={meal.id} className="together-meal-item">
                <div className="together-meal-info">
                  <strong>{meal.label}</strong>
                  <time dateTime={meal.occurredAt}>{formatLocalTime(meal.occurredAt, timeZone)}</time>
                </div>
                <div className="together-meal-macros">
                  <span className="meal-cals">{meal.caloriesBest} kcal</span>
                  <span className="meal-prot">{meal.proteinG}g P</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Completed Workouts Section */}
      <section className="together-feed-section" aria-label={`Completed workouts for ${member.displayName}`}>
        <h3 className="together-feed-title">
          <span>Workouts Completed</span>
          <small>{member.daily.workouts.length}</small>
        </h3>
        {member.daily.workouts.length === 0 ? (
          <div className="together-empty-feed">
            <p>No completed workouts for this day.</p>
          </div>
        ) : (
          <ul className="together-workouts-list">
            {member.daily.workouts.map((workout) => (
              <li key={workout.id} className="together-workout-item">
                <div className="together-workout-header">
                  <strong>{workout.name}</strong>
                  <time dateTime={workout.startedAt}>{formatLocalTime(workout.startedAt, timeZone)}</time>
                </div>
                <div className="together-workout-stats">
                  <span>{workout.setCount} sets</span>
                  <span>{workout.volumeKg} kg volume</span>
                  <span>{workout.exercises.length} {workout.exercises.length === 1 ? "exercise" : "exercises"}</span>
                </div>
                {workout.exercises.length > 0 && (
                  <div className="together-workout-exercises">
                    {workout.exercises.map((ex) => (
                      <span key={ex.id} className="together-exercise-tag">
                        {ex.name} ({ex.setCount}s)
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Trend Summary Section */}
      <section className="together-trend-section" aria-label={`${trendDays}-day trend summary for ${member.displayName}`}>
        <div className="together-trend-card">
          <div className="together-trend-meta">
            <span className="eyebrow">{trendDays}D Trend Summary</span>
            <small>{calc.trendSummary.loggedDaysCount} of {trendDays} days logged</small>
          </div>
          {calc.trendSummary.loggedDaysCount > 0 ? (
            <div className="together-trend-stats">
              <div>
                <strong>{calc.trendSummary.avgCalories}</strong>
                <span>kcal/day avg</span>
              </div>
              <div>
                <strong>{calc.trendSummary.avgProteinG}g</strong>
                <span>protein/day avg</span>
              </div>
            </div>
          ) : (
            <p className="together-empty-trend">No data logged in this {trendDays}-day window.</p>
          )}
        </div>
      </section>
    </div>
  );
}
