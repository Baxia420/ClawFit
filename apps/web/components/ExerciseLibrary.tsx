"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { muscleGroups, muscleLabels, youtubeVideoId, type ExerciseHistorySet, type LibraryExercise, type LibraryPage, type MuscleGroup, type Routine } from "@clawfit/health-core";
import { Body } from "./MuscleCoverage";

async function request<T>(path: string, command?: object): Promise<T> {
  const response = await fetch(path, command ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) } : { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? "Could not load. Try again.");
  return data as T;
}
export function LibraryDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="library-dialog training-page" aria-label={title} onCancel={onClose}><div className="library-dialog-header"><strong>{title}</strong><button type="button" className="training-button secondary" onClick={onClose}>Close</button></div>{children}</dialog>;
}
export function ExerciseLibrary({ onSelect, initialQuery = "" }: { initialQuery?: string; onSelect?: (exercise: LibraryExercise) => void }) {
  const [query, setQuery] = useState(initialQuery), [muscle, setMuscle] = useState(""), [equipment, setEquipment] = useState(""), [exerciseType, setType] = useState(""), [difficulty, setDifficulty] = useState(""), [scope, setScope] = useState("all");
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0), [page, setPage] = useState<LibraryPage | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<string | null>(null), [creating, setCreating] = useState(false), [focusPlan, setFocusPlan] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false), [actionError, setActionError] = useState("");
  const [savingFavorites, setSavingFavorites] = useState<Set<string>>(new Set());
  const favoriteRequests = useRef(new Set<string>());
  const filtersId = useId();
  const activeFilters = [scope !== "all", !!muscle, !!equipment, !!exerciseType, !!difficulty].filter(Boolean).length;
  const clearFilters = () => { setQuery(""); setMuscle(""); setEquipment(""); setType(""); setDifficulty(""); setScope("all"); setOffset(0); };
  async function toggleFavorite(exercise: LibraryExercise) {
    if (favoriteRequests.current.has(exercise.id)) return;
    favoriteRequests.current.add(exercise.id); setSavingFavorites(new Set(favoriteRequests.current)); setActionError("");
    try {
      await request("/api/exercise-library", { action: "favorite", id: exercise.id, favorite: !exercise.favorite });
      setRevision(n => n + 1);
    } catch (error) { setActionError(error instanceof Error ? error.message : "Could not update favorite."); }
    finally { favoriteRequests.current.delete(exercise.id); setSavingFavorites(new Set(favoriteRequests.current)); }
  }
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    const params = new URLSearchParams({ q: query, scope, offset: String(offset) });
    if (muscle) params.set("muscle", muscle); if (equipment) params.set("equipment", equipment); if (exerciseType) params.set("exerciseType", exerciseType); if (difficulty) params.set("difficulty", difficulty);
    const timer = setTimeout(() => { void fetch(`/api/exercise-library?${params}`, { signal: controller.signal }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? "Could not load exercises"); if (!controller.signal.aborted) { setPage(data); setLoading(false); } }).catch(error => { if (!controller.signal.aborted) { setError(error.message); setLoading(false); } }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, muscle, equipment, exerciseType, difficulty, scope, offset, revision]);
  const filter = (set: (value: string) => void, value: string) => { set(value); setOffset(0); };
  const counts = Object.fromEntries(muscleGroups.map(m => [m, m === muscle ? 1 : 0])) as Record<MuscleGroup, number>;
  return <section className="exercise-library">
    <div className="library-toolbar"><label className="library-search">Search exercises<input type="search" placeholder="Name, alias or muscle" value={query} onChange={e => filter(setQuery,e.target.value)} maxLength={160} /></label><button type="button" className="training-button secondary" onClick={() => setCreating(true)}>Create exercise</button></div>
    <div className="library-filter-actions"><button type="button" className="training-button secondary library-filter-toggle" aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen(open => !open)}>Filters{activeFilters ? ` (${activeFilters})` : ""}</button>{(activeFilters > 0 || query) && <button type="button" className="training-link-button" onClick={clearFilters}>Clear filters</button>}</div>
    <div id={filtersId} className={`library-filter-panel${filtersOpen ? " is-open" : ""}`}><div className="library-filters"><label>Collection<select value={scope} onChange={e => filter(setScope,e.target.value)}><option value="all">All exercises</option><option value="favorites">Favorites</option><option value="custom">My exercises</option></select></label><label>Muscle<select value={muscle} onChange={e => filter(setMuscle,e.target.value)}><option value="">All muscles</option>{muscleGroups.map(m => <option key={m} value={m}>{muscleLabels[m]}</option>)}</select></label><label>Equipment<select value={equipment} onChange={e => filter(setEquipment,e.target.value)}><option value="">All equipment</option>{page?.equipment.map(value => <option key={value}>{value}</option>)}</select></label><label>Type<select value={exerciseType} onChange={e => filter(setType,e.target.value)}><option value="">All types</option>{page?.exerciseTypes.map(value => <option key={value}>{value}</option>)}</select></label>{!!page?.difficulties.length && <label>Difficulty<select value={difficulty} onChange={e => filter(setDifficulty,e.target.value)}><option value="">All levels</option>{page.difficulties.map(value => <option key={value}>{value}</option>)}</select></label>}</div></div>
    <details className="library-muscles"><summary>Browse by muscle</summary><div className="body-map"><Body back={false} counts={counts} selected={muscle as MuscleGroup || null} select={m => filter(setMuscle,m)} unit="selected" /><Body back counts={counts} selected={muscle as MuscleGroup || null} select={m => filter(setMuscle,m)} unit="selected" /></div><button type="button" className="training-link-button" onClick={() => filter(setMuscle,"")}>Show all muscles</button></details>
    <div role="status" aria-live="polite" className="training-status">{loading ? "Loading exercises…" : error || `${page?.total ?? 0} exercises`}</div>
    {error ? <button type="button" className="training-button" onClick={() => setRevision(n => n+1)}>Retry</button> : <div className="library-list" aria-busy={loading}>
      {!loading && page?.items.length === 0 && <div className="training-empty"><h3>No exercises found</h3><p>Try another name or clear the filters.</p><button type="button" className="training-button secondary" onClick={clearFilters}>Clear filters</button></div>}
      {!loading && page?.items.map(exercise => <article key={exercise.id} className="library-row">
        <button type="button" className="library-row-open" aria-label={`View ${exercise.name}`} onClick={() => { setFocusPlan(false); setDetail(exercise.id); }}><strong>{exercise.name}</strong><span className="library-row-muscle">{exercise.primaryMuscles.join(", ") || muscleLabels[exercise.muscleGroup]}</span><span className="library-row-equipment">{exercise.equipment}</span></button>
        <div className="library-row-actions"><button type="button" className="library-favorite" aria-label={`${exercise.favorite ? "Unfavorite" : "Favorite"} ${exercise.name}`} aria-pressed={!!exercise.favorite} disabled={savingFavorites.has(exercise.id)} onClick={() => void toggleFavorite(exercise)}>{exercise.favorite ? "★" : "☆"}</button><button type="button" className="training-button secondary" onClick={() => { if (onSelect) onSelect(exercise); else { setFocusPlan(true); setDetail(exercise.id); } }}>{onSelect ? "Select exercise" : "Add to plan"}</button></div>
      </article>)}
    </div>}
    {actionError && <p role="alert">{actionError}</p>}
    {page && !loading && !error && page.total > page.limit && <nav className="library-pagination" aria-label="Exercise pages"><button type="button" className="training-button secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset-page.limit))}>Previous</button><span>{Math.min(offset+1,page.total)}–{Math.min(offset+page.limit,page.total)} of {page.total}</span><button type="button" className="training-button secondary" disabled={offset+page.limit >= page.total} onClick={() => setOffset(offset+page.limit)}>Next</button></nav>}
    {detail && <LibraryDialog title="Exercise details" onClose={() => { setDetail(null); setRevision(n => n+1); }}><ExerciseDetail id={detail} focusPlan={focusPlan} {...(onSelect ? { onSelect } : {})} /></LibraryDialog>}
    {creating && <LibraryDialog title="Create exercise" onClose={() => setCreating(false)}><CustomExerciseEditor onSaved={exercise => { setCreating(false); setFocusPlan(false); setDetail(exercise.id); setRevision(n=>n+1); }} /></LibraryDialog>}
  </section>;
}

export function ExerciseDetail({ id, onSelect, focusPlan = false }: { id: string; onSelect?: (exercise: LibraryExercise) => void; focusPlan?: boolean }) {
  const [exercise, setExercise] = useState<LibraryExercise | null>(null), [history, setHistory] = useState<ExerciseHistorySet[]>([]), [routines, setRoutines] = useState<Routine[]>([]);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [editing, setEditing] = useState(false), [video, setVideo] = useState(false);
  const [routineId, setRoutineId] = useState(""), [replace, setReplace] = useState("");
  const saving = useRef(false);
  const planRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (focusPlan && exercise) { planRef.current?.scrollIntoView({ block: "start" }); planRef.current?.querySelector("select")?.focus(); } }, [focusPlan, exercise?.id]);
  useEffect(() => { let cancelled = false; setExercise(null); setError("");
    void Promise.all([request<LibraryExercise>(`/api/exercise-library?id=${encodeURIComponent(id)}`), request<ExerciseHistorySet[]>(`/api/exercise-library?id=${encodeURIComponent(id)}&history=true`), request<{ routines: Routine[] }>("/api/training?plans=true")]).then(([e,h,p]) => { if (!cancelled) { setExercise(e); setHistory(h); setRoutines(p.routines.filter(r=>!r.archived)); } }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [id, revision]);
  async function write(action: () => Promise<void>) { if (saving.current) return; saving.current = true; setBusy(true); setMessage(""); try { await action(); } catch(error) { setMessage(error instanceof Error ? error.message : "Could not save"); } finally { saving.current=false; setBusy(false); } }
  if (error) return <div role="alert" className="training-card"><p>{error}</p><button className="training-button" onClick={() => setRevision(n=>n+1)}>Retry</button></div>;
  if (!exercise) return <p role="status" className="training-card">Loading exercise…</p>;
  if (editing) return <CustomExerciseEditor exercise={exercise} onSaved={e => { setExercise({ ...e, favorite: exercise.favorite ?? false }); setEditing(false); }} onCancel={() => setEditing(false)} />;
  const chosen = routines.find(r=>r.id===routineId);
  const videoId = exercise.mediaUrl ? youtubeVideoId(exercise.mediaUrl) : null;
  return <article className="training-card library-detail"><div className="training-heading"><div><span className="training-eyebrow">{exercise.custom ? "MY EXERCISE" : "EXERCISE LIBRARY"}</span><h2>{exercise.name}</h2><p>{exercise.equipment}{exercise.difficulty ? ` · ${exercise.difficulty}` : ""}</p></div><button className="training-button secondary" disabled={busy} aria-pressed={!!exercise.favorite} onClick={() => void write(async () => { const result = await request<{ favorite: boolean }>("/api/exercise-library", { action: "favorite", id, favorite: !exercise.favorite }); setExercise({ ...exercise, favorite: result.favorite }); })}>{exercise.favorite ? "★ Favorited" : "☆ Favorite"}</button></div>
    <h3>Instructions</h3><ol className="library-instructions">{exercise.instructions.map((step,i)=><li key={i}>{step}</li>)}</ol>
    <dl className="library-muscle-facts"><div><dt>Primary muscles</dt><dd>{exercise.primaryMuscles.join(", ")}</dd></div><div><dt>Secondary muscles</dt><dd>{exercise.secondaryMuscles.join(", ") || "Not specified"}</dd></div></dl>
    {(exercise.media.length > 0 || videoId) && <details className="library-media-details"><summary>Demonstration</summary>
      <div className="library-demonstrations">{exercise.media.map((media,index) => <figure key={media.src}><img src={media.src} alt={`${exercise.name}, position ${index+1}`} loading="lazy" width={480} height={340} /><figcaption>Illustration {index+1} · <a href={media.sourceUrl}>{media.author}</a> · <a href={media.licenseUrl}>{media.license}</a></figcaption></figure>)}</div>
      {videoId && (video ? <iframe className="library-video" src={`https://www.youtube-nocookie.com/embed/${videoId}`} title={`${exercise.name} video`} loading="lazy" referrerPolicy="no-referrer" allow="fullscreen" allowFullScreen /> : <button className="training-button secondary" onClick={() => setVideo(true)}>Load YouTube demonstration</button>)}
    </details>}
    {!exercise.custom && <p className="library-attribution">Exercise text: <a href="https://github.com/hasaneyldrm/exercises-dataset">Hasan Emir Yıldırım / exercises-dataset</a> · <a href="/exercise-media/text-license.txt">MIT license</a></p>}
    <div role="status" aria-live="polite" className="training-status">{busy ? "Saving…" : message}</div>
    {onSelect ? <button className="training-button" onClick={()=>onSelect(exercise)}>Select this exercise</button> : <form ref={planRef} className="panel training-card library-plan" onSubmit={event => { event.preventDefault(); if (!chosen) return; void write(async () => { const row = { name: exercise.name, libraryId: exercise.id, muscleGroup: exercise.muscleGroup, sets: 3, reps: 8, restSeconds: 90 }; const next = replace === "" ? [...chosen.exercises,row] : chosen.exercises.map((old,i)=>i===Number(replace) ? { ...old, name: row.name, libraryId: row.libraryId, muscleGroup: row.muscleGroup } : old); const saved = await request<Routine>("/api/training", { action: "updateRoutine", id: chosen.id, data: { name: chosen.name, archived: chosen.archived, version: chosen.version, exercises: next } }); setRoutines(rows=>rows.map(r=>r.id===saved.id?saved:r)); setMessage(replace === "" ? "Added to plan." : "Exercise replaced."); }); }}><h3>Add to plan</h3>{routines.length ? <><label>Routine<select required value={routineId} onChange={e=>{setRoutineId(e.target.value);setReplace("");}}><option value="">Select a routine</option>{routines.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>{chosen && <label>Position<select value={replace} onChange={e=>setReplace(e.target.value)}><option value="">Add at end</option>{chosen.exercises.map((e,i)=><option key={i} value={i}>Replace {i+1}. {e.name}</option>)}</select></label>}<button className="training-button" disabled={busy || !chosen || (replace === "" && chosen.exercises.length >= 30)}>{replace === "" ? "Add exercise" : "Replace exercise"}</button></> : <p><Link href="/workouts?tab=plans">Create a routine</Link> to add this exercise.</p>}</form>}
    {exercise.custom && <button className="training-link-button" onClick={()=>setEditing(true)}>Edit custom exercise</button>}
    <section className="library-history"><h3>Your history</h3>{history.length ? <><p>Best estimated 1RM: {Math.max(...history.map(s=>s.estimatedOneRepMax ?? 0)) || "—"} kg · latest {history.length} sets</p><div className="library-history-scroll"><table><thead><tr><th>Date</th><th>Workout</th><th>Load</th><th>Reps</th></tr></thead><tbody>{history.map(s=><tr key={s.id}><td>{new Date(s.occurredAt).toLocaleDateString()}</td><td>{s.workoutName}</td><td>{s.weightKg === null ? "Bodyweight" : `${s.weightKg} kg`}</td><td>{s.reps}</td></tr>)}</tbody></table></div></> : <p className="training-muted">No logged sets for this exercise yet.</p>}</section>
  </article>;
}

function CustomExerciseEditor({ exercise, onSaved, onCancel }: { exercise?: LibraryExercise; onSaved: (exercise: LibraryExercise) => void; onCancel?: () => void }) {
  const [name,setName]=useState(exercise?.name ?? ""), [instructions,setInstructions]=useState(exercise?.instructions.join("\n") ?? ""), [muscle,setMuscle]=useState<MuscleGroup>(exercise?.muscleGroup ?? "other"), [primary,setPrimary]=useState(exercise?.primaryMuscles.join(", ") ?? ""), [secondary,setSecondary]=useState(exercise?.secondaryMuscles.join(", ") ?? ""), [equipment,setEquipment]=useState(exercise?.equipment ?? "body weight"), [mediaUrl,setMediaUrl]=useState(exercise?.mediaUrl ?? "");
  const [exerciseType,setType]=useState(exercise?.exerciseType ?? ""), [difficulty,setDifficulty]=useState(exercise?.difficulty ?? ""), [error,setError]=useState(""), [busy,setBusy]=useState(false);
  const operation = useRef<{ signature: string; key: string } | null>(null), saving=useRef(false);
  async function save(event: FormEvent) { event.preventDefault(); if(saving.current)return; saving.current=true;setBusy(true);setError(""); try {
    const data = { name,instructions: instructions.split("\n").map(s=>s.trim()).filter(Boolean),muscleGroup:muscle,primaryMuscles:primary.split(",").map(s=>s.trim()).filter(Boolean),secondaryMuscles:secondary.split(",").map(s=>s.trim()).filter(Boolean),equipment,mediaUrl,exerciseType:exerciseType || null,difficulty:difficulty || null };
    const signature=JSON.stringify(data);if(operation.current?.signature!==signature)operation.current={signature,key:crypto.randomUUID()};
    const saved=await request<LibraryExercise>("/api/exercise-library",exercise ? {action:"update",id:exercise.id,data:{...data,version:exercise.version}} : {action:"create",data:{...data,idempotencyKey:operation.current.key}});onSaved(saved);
  }catch(error){setError(error instanceof Error?error.message:"Could not save");}finally{saving.current=false;setBusy(false);} }
  return <form className="training-card custom-exercise-form" onSubmit={save}><label>Name<input required maxLength={160} value={name} onChange={e=>setName(e.target.value)} /></label><div className="training-field-row"><label>Primary group<select value={muscle} onChange={e=>setMuscle(e.target.value as MuscleGroup)}>{muscleGroups.map(m=><option key={m} value={m}>{muscleLabels[m]}</option>)}</select></label><label>Equipment<input required maxLength={80} value={equipment} onChange={e=>setEquipment(e.target.value)} /></label></div><label>Primary muscles (comma separated)<input required value={primary} onChange={e=>setPrimary(e.target.value)} maxLength={480} /></label><label>Secondary muscles (comma separated)<input value={secondary} onChange={e=>setSecondary(e.target.value)} maxLength={720} /></label><div className="training-field-row"><label>Type<select value={exerciseType} onChange={e=>setType(e.target.value)}><option value="">Not specified</option>{["strength","cardio","stretching","balance"].map(v=><option key={v}>{v}</option>)}</select></label><label>Difficulty<select value={difficulty} onChange={e=>setDifficulty(e.target.value)}><option value="">Not specified</option>{["beginner","intermediate","advanced"].map(v=><option key={v}>{v}</option>)}</select></label></div><label>Instructions (one step per line)<textarea required rows={7} maxLength={45000} value={instructions} onChange={e=>setInstructions(e.target.value)} /></label><label>YouTube demonstration (optional)<input type="url" maxLength={300} placeholder="https://www.youtube.com/watch?v=…" value={mediaUrl} onChange={e=>setMediaUrl(e.target.value)} /></label><p className="training-muted">Use a video you own or have permission to share. Videos load only when opened.</p><p role="status">{error}</p><div className="training-actions"><button className="training-button" disabled={busy}>{busy?"Saving…":"Save exercise"}</button>{onCancel&&<button type="button" className="training-button secondary" onClick={onCancel}>Cancel</button>}</div></form>;
}
