"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { day: string; logged?: boolean; mealCount?: number | undefined; caloriesBest?: number | null; caloriesLow?: number | null; caloriesHigh?: number | null; proteinG?: number | null; estimatedOneRepMax?: number; knownCalories?: number | undefined; knownProteinG?: number | undefined; missingCalories?: number | undefined; missingProtein?: number | undefined };
type Mode = "calories" | "protein" | "e1rm";

export function TrendTooltip({ point, mode }: { point: Point | undefined; mode: Mode }) {
  if (!point) return null;
  const value = mode === "calories" ? point.caloriesBest : mode === "protein" ? point.proteinG : point.estimatedOneRepMax;
  const known = mode === "calories" ? point.knownCalories : point.knownProteinG;
  const missing = mode === "calories" ? point.missingCalories : point.missingProtein;
  const unit = mode === "calories" ? "kcal" : mode === "protein" ? "g protein" : "kg";
  return <div className="chart-tooltip">
    <strong>{point.day}</strong>
    {point.logged === false ? <p>No meals logged</p> : value == null ? <>
      <p>{known === undefined || missing === point.mealCount ? "Total incomplete" : `${Math.round(known * 10) / 10} ${unit} known subtotal`}</p>
      <p>{missing === undefined ? "Values missing from one or more meals" : `${missing} ${missing === 1 ? "meal" : "meals"} missing values`}</p>
    </> : <p>{Math.round(value * 10) / 10} {unit}</p>}
    {mode === "calories" && point.logged !== false && <p>{point.caloriesLow == null || point.caloriesHigh == null ? "Calorie range incomplete" : `Range: ${point.caloriesLow}–${point.caloriesHigh} kcal`}</p>}
  </div>;
}

export function TrendChart({ data, mode = "calories" }: { data: Point[]; mode?: Mode }) {
  const key = mode === "calories" ? "caloriesBest" : mode === "protein" ? "proteinG" : "estimatedOneRepMax";
  const points = data.map(point => ({ ...point, calorieRange: point.caloriesLow == null || point.caloriesHigh == null ? null : [point.caloriesLow, point.caloriesHigh] }));
  return (
    <div className="chart" role="img" aria-label={`${mode} trend chart; gaps indicate unlogged or incomplete days`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 12, right: 8, left: -20, bottom: 0 }}>
          <defs><linearGradient id={`fill-${mode}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b8f34a" stopOpacity={0.55} /><stop offset="100%" stopColor="#b8f34a" stopOpacity={0.02} /></linearGradient></defs>
          <CartesianGrid stroke="#d7d5ca" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="day" tickFormatter={(value: string) => value.slice(5, 10)} tick={{ fontSize: 11, fill: "#5e625c" }} axisLine={false} tickLine={false} />
          <YAxis domain={[0, "auto"]} tick={{ fontSize: 11, fill: "#5e625c" }} axisLine={false} tickLine={false} />
          <Tooltip filterNull={false} content={props => props.active ? <TrendTooltip point={points.find(point => point.day === String(props.label))} mode={mode} /> : null} />
          {mode === "calories" && <Area type="linear" dataKey="calorieRange" stroke="none" fill="#b8f34a" fillOpacity={0.4} connectNulls={false} />}
          <Area type="linear" dataKey={key} stroke="#171b18" strokeWidth={2.5} fill={mode === "calories" ? "none" : `url(#fill-${mode})`} connectNulls={false} dot={{ r: 2, fill: "#171b18" }} activeDot={{ r: 5, fill: "#b8f34a", stroke: "#171b18" }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
