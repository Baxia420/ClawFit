export function Metric({ label, value, unit, accent = false, hint }: { label: string; value: string | number; unit?: string; accent?: boolean; hint?: string }) {
  return (
    <article className={`metric ${accent ? "metric-accent" : ""}`}>
      <span className="eyebrow">{label}</span>
      <strong>{value}<small>{unit}</small></strong>
      {hint && <p>{hint}</p>}
    </article>
  );
}

