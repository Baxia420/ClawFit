"use client";
import { useState } from "react";
import { muscleGroups, muscleLabels, type MuscleGroup } from "@clawfit/health-core";

// Original simplified front/back artwork for ClawFit. A primary-muscle set map, not a recovery model.
const shapes: Partial<Record<MuscleGroup, string[]>> = {
  chest: ["M58 74 Q76 66 97 78 L96 111 Q71 121 59 102Z", "M103 78 Q124 66 142 74 L141 102 Q129 121 104 111Z"],
  shoulders: ["M54 64 Q36 67 37 91 L54 103 L59 79Z", "M146 64 Q164 67 163 91 L146 103 L141 79Z"],
  biceps: ["M36 101 L52 110 L49 143 Q32 150 28 140Z", "M164 101 L148 110 L151 143 Q168 150 172 140Z"],
  triceps: ["M36 101 L52 110 L49 143 Q32 150 28 140Z", "M164 101 L148 110 L151 143 Q168 150 172 140Z"],
  core: ["M77 123 L97 124 L97 151 L76 147Z", "M103 124 L123 123 L124 147 L103 151Z", "M76 155 L97 157 L96 195 L79 184Z", "M103 157 L124 155 L121 184 L104 195Z"],
  back: ["M61 78 Q78 63 97 72 L96 145 L80 174 L66 137Z", "M103 72 Q122 63 139 78 L134 137 L120 174 L104 145Z"],
  quads: ["M69 214 Q87 206 97 223 L89 287 L67 282Z", "M103 223 Q113 206 131 214 L133 282 L111 287Z"],
  hamstrings: ["M69 224 Q86 218 97 231 L88 287 L67 281Z", "M103 231 Q114 218 131 224 L133 281 L112 287Z"],
  glutes: ["M68 178 Q85 172 98 190 L96 217 Q78 225 66 209Z", "M102 190 Q115 172 132 178 L134 209 Q122 225 104 217Z"],
  calves: ["M68 295 L87 298 L84 333 Q77 347 69 335Z", "M113 298 L132 295 L131 335 Q123 347 116 333Z"],
};
function Body({ back, counts, selected, select }: { back: boolean; counts: Record<MuscleGroup, number>; selected: MuscleGroup | null; select: (muscle: MuscleGroup) => void }) {
  const visible: MuscleGroup[] = back ? ["back", "shoulders", "triceps", "glutes", "hamstrings", "calves"] : ["chest", "shoulders", "biceps", "core", "quads", "calves"];
  const max = Math.max(1, ...Object.values(counts));
  return <figure><svg viewBox="0 0 200 380" role="group" aria-label={back ? "Back muscle coverage" : "Front muscle coverage"}>
    <circle cx="100" cy="28" r="22" fill="var(--training-inert)" />
    <path d="M87 50 L113 50 L116 61 Q151 57 163 82 L177 154 L182 191 L170 199 L153 153 L143 119 L134 175 L141 220 L139 292 L133 349 L145 360 L143 369 L111 369 L109 340 L103 278 L100 241 L97 278 L91 340 L89 369 L57 369 L55 360 L67 349 L61 292 L59 220 L66 175 L57 119 L47 153 L30 199 L18 191 L23 154 L37 82 Q49 57 84 61Z" fill="var(--training-inert)" />
    {visible.map(muscle => <g key={muscle} role="button" tabIndex={0} aria-label={`${muscleLabels[muscle]}: ${counts[muscle]} sets`} aria-pressed={selected === muscle} onClick={() => select(muscle)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(muscle); } }} className={selected === muscle ? "muscle-region selected" : "muscle-region"}>
      <title>{muscleLabels[muscle]} · {counts[muscle]} sets</title>
      {(shapes[muscle] ?? []).map((path,index) => <path key={index} d={path} fill={counts[muscle] === 0 ? "var(--training-unworked)" : counts[muscle] / max > .6 ? "var(--teal)" : "var(--acid)"} />)}
    </g>)}
  </svg><figcaption>{back ? "Back" : "Front"}</figcaption></figure>;
}
export function MuscleCoverage({ counts }: { counts: Record<MuscleGroup, number> }) {
  const [selected, setSelected] = useState<MuscleGroup | null>(null);
  const max = Math.max(1, ...Object.values(counts));
  return <div className="muscle-coverage"><div className="body-map"><Body back={false} counts={counts} selected={selected} select={setSelected} /><Body back counts={counts} selected={selected} select={setSelected} /></div>
    <div className="muscle-breakdown"><p className="training-muted">Logged sets, grouped by primary muscle. Tap a muscle to explore.</p>
      {muscleGroups.map(muscle => <button type="button" key={muscle} className={selected === muscle ? "selected" : ""} aria-pressed={selected === muscle} onClick={() => setSelected(muscle)}><span>{muscleLabels[muscle]}</span><i><b style={{ width: `${counts[muscle] / max * 100}%` }} /></i><strong>{counts[muscle]}</strong></button>)}
      <p className="training-muted">A compound exercise can work several muscles; this view counts each set once. It does not estimate fatigue or recovery.</p>
    </div></div>;
}
