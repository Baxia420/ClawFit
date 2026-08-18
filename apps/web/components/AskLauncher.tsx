"use client";

export function AskLauncher({ label = "Ask ClawFit", prompt, className = "quick-ask" }: { label?: string; prompt?: string; className?: string }) {
  return <button className={className} type="button" onClick={() => window.dispatchEvent(new CustomEvent("clawfit:ask", { detail: { prompt } }))}>{label}</button>;
}
