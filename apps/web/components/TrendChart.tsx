"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { day: string; caloriesBest?: number; caloriesLow?: number; caloriesHigh?: number; proteinG?: number; estimatedOneRepMax?: number };

export function TrendChart({ data, mode = "calories" }: { data: Point[]; mode?: "calories" | "protein" | "e1rm" }) {
  const key = mode === "calories" ? "caloriesBest" : mode === "protein" ? "proteinG" : "estimatedOneRepMax";
  return (
    <div className="chart" role="img" aria-label={`${mode} trend chart`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 12, right: 8, left: -20, bottom: 0 }}>
          <defs><linearGradient id={`fill-${mode}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b8f34a" stopOpacity={0.55} /><stop offset="100%" stopColor="#b8f34a" stopOpacity={0.02} /></linearGradient></defs>
          <CartesianGrid stroke="#d7d5ca" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="day" tickFormatter={(value: string) => value.slice(5, 10)} tick={{ fontSize: 11, fill: "#5e625c" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "#5e625c" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ background: "#171b18", border: 0, color: "#f1f0e8", fontFamily: "var(--font-mono)", fontSize: 12 }} />
          <Area type="monotone" dataKey={key} stroke="#171b18" strokeWidth={2.5} fill={`url(#fill-${mode})`} dot={{ r: 2, fill: "#171b18" }} activeDot={{ r: 5, fill: "#b8f34a", stroke: "#171b18" }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

