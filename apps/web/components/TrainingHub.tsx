"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { exerciseSuggestions, muscleForExercise, muscleGroups, muscleLabels, routineDefinitionSchema, type MuscleGroup, type Routine, type RoutineExercise, type ScheduleDay, type TrainingStats, type WeightHistory } from "@clawfit/health-core";
import type { Settings, Workout } from "../lib/api";
import { formatLocalDate } from "../lib/dates";
import { Metric } from "./Metric";
import { MuscleCoverage } from "./MuscleCoverage";
import { ActivityChart, WeightChart } from "./TrainingCharts";
export type TrainingTab = "train" | "plans" | "stats" | "weight";
type Props = { tab: TrainingTab; date: string; today: string; days: number; settings: Settings; active: Workout | null; history: Workout[]; routines: Routine[]; schedule: ScheduleDay[]; stats: TrainingStats | null; weight: WeightHistory | null };
const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const blankExercise = (): RoutineExercise => ({ name: "", muscleGroup: "other", sets: 3, reps: 8, restSeconds: 90 });
const round = (value: number) => Math.round(value * 10) / 10;

export function TrainingHub(props: Props) {
  const { tab, date, today, days, settings, active, history, routines, schedule, stats, weight } = props;
  const router = useRouter();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const saving = useRef(false);
  // Keep an operation's key after a network error; retries must refer to the same write.
  const operationKeys = useRef(new Map<string, { signature: string; key: string }>());
  function key(operation: string, input: object) { const signature = JSON.stringify(input); const existing = operationKeys.current.get(operation); if (existing?.signature === signature) return existing.key; const created = crypto.randomUUID(); operationKeys.current.set(operation, { signature, key: created }); return created; }
  async function write(command: object, operation?: string) {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/training", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save; retry.");
      if (operation) operationKeys.current.delete(operation);
      setMessage("Saved."); router.refresh(); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save; retry."); return false; }
    finally { saving.current = false; setBusy(false); }
  }
  const [workoutName, setWorkoutName] = useState("");
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null), [editorOpen, setEditorOpen] = useState(false);
  const [routineName, setRoutineName] = useState(""), [routineExercises, setRoutineExercises] = useState<RoutineExercise[]>([blankExercise()]);
  const [weighDay, setWeighDay] = useState(today), [weighKg, setWeighKg] = useState(""), [weighNotes, setWeighNotes] = useState("");
  const [goalKg, setGoalKg] = useState(weight?.goalKg?.toString() ?? "");
  useEffect(() => { setGoalKg(weight?.goalKg?.toString() ?? ""); }, [weight?.goalKg]);
  const [exerciseName, setExerciseName] = useState(active?.exercises[0]?.name ?? ""), [muscle, setMuscle] = useState<MuscleGroup>(active?.exercises[0]?.muscleGroup ?? "other");
  const [loadKg, setLoadKg] = useState(""), [bodyweight, setBodyweight] = useState(false), [reps, setReps] = useState(String(active?.workout.routineSnapshot?.exercises[0]?.reps ?? 8));
  const [editSetId, setEditSetId] = useState<string | null>(null);
  const [restUntil, setRestUntil] = useState<number | null>(null), [restRemaining, setRestRemaining] = useState(0);
  const [previous, setPrevious] = useState<{ sets: { weightKg: number | null; reps: number }[] } | null>(null);
  useEffect(() => {
    if (!restUntil) return;
    const tick = () => setRestRemaining(Math.max(0, Math.ceil((restUntil - Date.now()) / 1000)));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [restUntil]);
  const lastWorkoutId = useRef(active?.workout.id);
  useEffect(() => {
    if (lastWorkoutId.current === active?.workout.id) return;
    lastWorkoutId.current = active?.workout.id;
    setRestUntil(null); setEditSetId(null); setLoadKg(""); setBodyweight(false);
    setExerciseName(active?.exercises[0]?.name ?? "");
    setMuscle(active?.exercises[0]?.muscleGroup ?? "other");
    setReps(String(active?.workout.routineSnapshot?.exercises[0]?.reps ?? 8));
  }, [active]);
  useEffect(() => {
    setPrevious(null);
    if (!active || !exerciseName.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void fetch(`/api/training?${new URLSearchParams({ exercise: exerciseName.trim(), before: active.workout.startedAt })}`, { signal: controller.signal }).then(async response => { if (response.ok) setPrevious(await response.json()); }).catch(() => {}); }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active?.workout.id, active?.workout.startedAt, exerciseName]);
  const available = routines.filter(r => !r.archived);
  const weekday = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const planned = available.find(r => r.id === schedule.find(s => s.weekday === weekday)?.routineId);
  const target = active?.workout.routineSnapshot?.exercises.find(e => e.name.toLowerCase() === exerciseName.trim().toLowerCase());
  const selectedExercise = active?.exercises.find(e => e.name.toLowerCase() === exerciseName.trim().toLowerCase());
  const selectedMuscle = selectedExercise?.muscleGroup ?? muscle;
  async function start(routine?: Routine) {
    const operation = "start";
    const data = { name: routine?.name ?? workoutName.trim(), ...(routine ? { routineId: routine.id } : {}) };
    await write({ action: "start", data: { ...data, idempotencyKey: key(operation, data) } }, operation);
  }
  function chooseExercise(name: string) {
    setExerciseName(name); setEditSetId(null);
    const existing = active?.exercises.find(e => e.name === name);
    setMuscle(existing?.muscleGroup ?? muscleForExercise(name));
    const plannedExercise = active?.workout.routineSnapshot?.exercises.find(e => e.name === name);
    if (plannedExercise) setReps(String(plannedExercise.reps));
  }
  async function logSet(event: FormEvent) {
    event.preventDefault(); if (!active) return;
    const operation = `set:${active.workout.id}`;
    const data = { weightKg: bodyweight ? null : Number(loadKg), reps: Number(reps) };
    const setData = { ...data, exerciseName: exerciseName.trim(), muscleGroup: selectedMuscle };
    const success = await write(editSetId ? { action: "editSet", id: editSetId, data } : { action: "set", id: active.workout.id, data: { ...setData, idempotencyKey: key(operation, setData) } }, editSetId ? undefined : operation);
    if (success) { setEditSetId(null); if (!editSetId) { const rest = target?.restSeconds ?? 90; setRestRemaining(rest); setRestUntil(Date.now() + rest * 1000); } }
  }
  function editRoutine(routine: Routine | null) {
    setEditingRoutine(routine); setRoutineName(routine?.name ?? ""); setRoutineExercises(routine ? structuredClone(routine.exercises) : [blankExercise()]); setEditorOpen(true); setMessage("");
  }
  function patchExercise(index: number, patch: Partial<RoutineExercise>) { setRoutineExercises(current => current.map((row,i) => i === index ? { ...row, ...patch } : row)); }
  async function saveRoutine(event: FormEvent) {
    event.preventDefault(); const result = routineDefinitionSchema.safeParse({ name: routineName, exercises: routineExercises, archived: editingRoutine?.archived ?? false });
    if (!result.success) { setMessage(result.error.issues[0]?.message ?? "Check the routine"); return; }
    const operation = "routine";
    const success = await write(editingRoutine ? { action: "updateRoutine", id: editingRoutine.id, data: { ...result.data, version: editingRoutine.version } } : { action: "createRoutine", data: { ...result.data, idempotencyKey: key(operation, result.data) } }, editingRoutine ? undefined : operation);
    if (success) { setEditorOpen(false); setEditingRoutine(null); }
  }
  const rangeLink = (duration: number) => `/workouts?${new URLSearchParams({ tab, days: String(duration), date })}`;
  const firstWeight = weight?.entries[0], latestWeight = weight?.entries.at(-1);
  return <div className="page training-page"><header className="page-header compact"><div><span className="kicker">CLAWFIT / TRAINING</span><h1>Workout<br /><em>log.</em></h1></div><div className="header-code">ROUTINES / SETS<br />WEEKLY WEIGH-INS</div></header>
    <nav className="training-tabs" aria-label="Training sections">{([['train','Train'],['plans','Plans'],['stats','Stats'],['weight','Body weight']] as const).map(([id,label]) => <Link key={id} href={`/workouts?tab=${id}`} aria-current={tab === id ? "page" : undefined}>{label}</Link>)}</nav>
    <div role="status" aria-live="polite" className="training-status">{busy ? "Saving…" : message}</div>
    <datalist id="training-exercises">{exerciseSuggestions.map(e => <option key={e.name} value={e.name} />)}</datalist>
    {tab === "train" && <>
      {active ? <section className="panel training-card active-session"><div className="training-heading"><div><span className="training-eyebrow">IN PROGRESS</span><h2>{active.workout.name}</h2><p>{active.setCount} logged sets · {round(active.volumeKg).toLocaleString()} kg external-load volume</p></div><button disabled={busy} className="training-button" onClick={() => void write({ action: "finish", id: active.workout.id })}>Finish workout</button></div>
        <div className="training-session-grid"><div>{active.exercises.map(exercise => {
          const plannedExercise = active.workout.routineSnapshot?.exercises.find(e => e.name === exercise.name);
          return <article key={exercise.id} className="exercise-card"><button className="exercise-title" onClick={() => chooseExercise(exercise.name)}>{exercise.name}<span>{exercise.sets.length}{plannedExercise ? ` / ${plannedExercise.sets}` : ""} sets</span></button><small>{muscleLabels[exercise.muscleGroup ?? "other"]}{plannedExercise ? ` · target ${plannedExercise.reps} reps` : ""}</small>
            {exercise.sets.length ? <div className="logged-sets">{exercise.sets.map(set => <button key={set.id} disabled={busy} onClick={() => { chooseExercise(exercise.name); setEditSetId(set.id); setBodyweight(set.weightKg === null); setLoadKg(set.weightKg?.toString() ?? ""); setReps(String(set.reps)); }} aria-label={`Edit ${exercise.name} set ${set.setNumber}`}><span>{set.setNumber}</span><strong>{set.weightKg === null ? "Bodyweight" : `${round(set.weightKg)} kg`} × {set.reps}</strong><small>Edit</small></button>)}</div> : <p className="training-muted">No sets logged for this exercise.</p>}
          </article>;
        })}</div><form onSubmit={logSet} className="set-entry"><h3>{editSetId ? "Edit logged set" : "Log a set"}</h3><label>Exercise<input list="training-exercises" value={exerciseName} onChange={event => chooseExercise(event.target.value)} required maxLength={160} disabled={!!editSetId} /></label><label>Primary muscle<select value={selectedMuscle} onChange={event => setMuscle(event.target.value as MuscleGroup)} disabled={!!selectedExercise?.muscleGroup || !!editSetId}>{muscleGroups.map(m => <option key={m} value={m}>{muscleLabels[m]}</option>)}</select></label>
          {target && <p className="training-muted">Target: {target.sets} sets × {target.reps} reps · {target.restSeconds}s rest</p>}
          {previous && previous.sets.length > 0 && <div className="previous-performance"><small>LAST SESSION</small><p>{previous.sets.map(s => `${s.weightKg ?? "BW"} × ${s.reps}`).join(" · ")}</p><button type="button" className="training-link-button" onClick={() => { const last = previous.sets.at(-1)!; setBodyweight(last.weightKg === null); setLoadKg(last.weightKg?.toString() ?? ""); setReps(String(last.reps)); }}>Use last set values</button></div>}
          <label className="training-checkbox"><input type="checkbox" checked={bodyweight} onChange={event => setBodyweight(event.target.checked)} />Bodyweight / no external load</label><div className="training-field-row"><label>Load (kg)<input type="number" min={0} max={1000} step="0.5" value={loadKg} onChange={event => setLoadKg(event.target.value)} disabled={bodyweight} required={!bodyweight} /></label><label>Reps<input type="number" min={1} max={1000} step={1} value={reps} onChange={event => setReps(event.target.value)} required /></label></div><button disabled={busy} className="training-button">{editSetId ? "Save correction" : "Log set"}</button>{editSetId && <button type="button" className="training-link-button" onClick={() => setEditSetId(null)}>Cancel edit</button>}
          {restUntil !== null && <div className="rest-timer"><strong>{restRemaining > 0 ? `${Math.floor(restRemaining / 60)}:${String(restRemaining % 60).padStart(2,"0")}` : "Rest complete"}</strong><button type="button" onClick={() => setRestUntil(null)}>Skip / close</button></div>}
        </form></div>
      </section> : <section className="panel training-card training-start"><div><span className="training-eyebrow">TODAY · {weekdayNames[weekday - 1]}</span><h2>{planned ? planned.name : "Start a workout"}</h2><p>{planned ? `${planned.exercises.length} exercises · ${planned.exercises.reduce((sum,e) => sum + e.sets,0)} planned sets` : "Enter a workout name or select a saved routine."}</p>{planned && <button disabled={busy} className="training-button" onClick={() => void start(planned)}>Start today’s routine</button>}</div><form onSubmit={event => { event.preventDefault(); void start(); }}><label>Quick workout<input value={workoutName} onChange={event => setWorkoutName(event.target.value)} placeholder="e.g. Upper body" maxLength={120} required /></label><button disabled={busy || !workoutName.trim()} className="training-button secondary">Start blank workout</button></form></section>}
      {available.length > 0 && !active && <section className="routine-grid">{available.map(r => <article key={r.id} className="panel training-card"><span className="training-eyebrow">SAVED ROUTINE</span><h3>{r.name}</h3><p>{r.exercises.length} exercises</p><button className="training-button secondary" disabled={busy} onClick={() => void start(r)}>Start routine</button></article>)}</section>}
      <section className="panel training-card"><div className="panel-title training-heading"><h2>02 / RECENT WORKOUTS</h2><span className="training-muted">{history.length} sessions</span></div>{history.length ? history.map(session => <details className="session-history" key={session.workout.id}><summary><span><strong>{session.workout.name}</strong><small>{formatLocalDate(session.workout.startedAt, settings.timezone)} · {session.workout.status}</small></span><span>{session.setCount} sets · {round(session.volumeKg).toLocaleString()} kg</span></summary>{session.exercises.map(exercise => <div className="history-exercise" key={exercise.id}><Link href={`/exercises/${encodeURIComponent(exercise.name)}`}>{exercise.name}</Link><span>{exercise.sets.map(s => `${s.weightKg ?? "BW"} × ${s.reps}`).join(" · ") || "No sets logged"}</span></div>)}</details>) : <div className="training-empty"><h3>No workouts logged</h3><p>Start a workout to record exercises and sets.</p></div>}</section>
    </>}
    {tab === "plans" && <><section className="panel training-card"><div className="training-heading"><div><span className="training-eyebrow">01 / PLANS</span><h2>Weekly schedule</h2><p>Assign a routine to each day. Scheduled workouts are not counted as completed.</p></div><button className="training-button" disabled={busy} onClick={() => editRoutine(null)}>Create routine</button></div><div className="week-schedule">{weekdayNames.map((name,index) => <label className={weekday === index + 1 ? "today" : ""} key={name}><span>{name.slice(0,3)}{weekday === index + 1 && <small>Today</small>}</span><select aria-label={`${name} routine`} value={schedule.find(s => s.weekday === index + 1)?.routineId ?? ""} disabled={busy} onChange={event => void write({ action: "schedule", weekday: index + 1, data: { routineId: event.target.value || null } })}><option value="">Rest day</option>{available.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>)}</div></section>
      {editorOpen && <form className="panel training-card routine-editor" onSubmit={saveRoutine}><h2>{editingRoutine ? "Edit routine" : "Create routine"}</h2><label>Routine name<input value={routineName} onChange={event => setRoutineName(event.target.value)} required maxLength={120} placeholder="e.g. Push day" /></label><div className="routine-exercises">{routineExercises.map((exercise,index) => <fieldset key={index}><legend>Exercise {index + 1}</legend><label>Name<input value={exercise.name} list="training-exercises" onChange={event => patchExercise(index, { name: event.target.value, muscleGroup: muscleForExercise(event.target.value) })} required maxLength={160} /></label><label>Primary muscle<select value={exercise.muscleGroup} onChange={event => patchExercise(index, { muscleGroup: event.target.value as MuscleGroup })}>{muscleGroups.map(m => <option key={m} value={m}>{muscleLabels[m]}</option>)}</select></label><div className="training-field-row"><label>Sets<input type="number" min={1} max={20} value={exercise.sets} onChange={event => patchExercise(index, { sets: Number(event.target.value) })} required /></label><label>Target reps<input type="number" min={1} max={100} value={exercise.reps} onChange={event => patchExercise(index, { reps: Number(event.target.value) })} required /></label><label>Rest (seconds)<input type="number" min={0} max={900} value={exercise.restSeconds} onChange={event => patchExercise(index, { restSeconds: Number(event.target.value) })} required /></label></div><div className="routine-row-actions"><button type="button" disabled={index === 0 || busy} onClick={() => setRoutineExercises(rows => { const next = [...rows]; [next[index-1], next[index]] = [next[index]!, next[index-1]!]; return next; })}>Move up</button><button type="button" disabled={routineExercises.length === 1 || busy} onClick={() => setRoutineExercises(rows => rows.filter((_,i) => i !== index))}>Remove</button></div></fieldset>)}</div><div className="training-actions"><button type="button" className="training-button secondary" disabled={routineExercises.length >= 30 || busy} onClick={() => setRoutineExercises(rows => [...rows, blankExercise()])}>Add exercise</button><button className="training-button" disabled={busy}>Save routine</button><button type="button" className="training-link-button" disabled={busy} onClick={() => setEditorOpen(false)}>Cancel</button></div></form>}
      <section className="routine-grid">{routines.map(routine => <article key={routine.id} className={`panel training-card ${routine.archived ? "archived-routine" : ""}`}><span className="training-eyebrow">{routine.archived ? "ARCHIVED" : `${routine.exercises.length} EXERCISES`}</span><h3>{routine.name}</h3><ul className="routine-preview">{routine.exercises.map(e => <li key={e.name}><span>{e.name}</span><strong>{e.sets} × {e.reps}</strong></li>)}</ul><div className="training-actions"><button className="training-button secondary" disabled={busy} onClick={() => editRoutine(routine)}>Edit</button><button className="training-link-button" disabled={busy} onClick={() => void write({ action: "updateRoutine", id: routine.id, data: { name: routine.name, exercises: routine.exercises, archived: !routine.archived, version: routine.version } })}>{routine.archived ? "Restore" : "Archive"}</button></div></article>)}</section>{!routines.length && !editorOpen && <div className="training-empty"><h3>No routines saved</h3><p>Create a routine with your exercises, sets, reps and rest time.</p></div>}</>}
    {(tab === "stats" || tab === "weight") && <div className="training-range"><div className="training-tabs">{[7,30,90].map(duration => <Link key={duration} href={rangeLink(duration)} aria-current={days === duration ? "page" : undefined}>{String(duration).padStart(2, "0")}D</Link>)}</div><form method="GET"><input type="hidden" name="tab" value={tab} /><input type="hidden" name="days" value={days} /><label>Through <input type="date" name="date" defaultValue={date} max={today} /></label><button className="training-button secondary">View</button></form></div>}
    {tab === "stats" && stats && <><section className="metric-grid training-metrics">
        <Metric label="COMPLETED WORKOUTS" value={stats.workoutCount} accent hint={`${stats.activeDays} training days`} />
        <Metric label="LOGGED SETS" value={stats.totalSets} hint={`${stats.totalReps} reps`} />
        <Metric label="LIFTED VOLUME" value={stats.volumeKg.toLocaleString()} unit="kg" hint="External load only" />
        <Metric label="SESSION DURATION" value={stats.minutes} unit="min" hint="Includes rest between sets" />
      </section><section className="panel training-card"><div className="training-heading"><div><span className="training-eyebrow">LAST {days} DAYS · THROUGH {date}</span><h2>Sets by muscle</h2></div></div><MuscleCoverage counts={stats.muscleSets} />{!stats.workoutCount && <p className="training-muted">No completed workouts in this date range. The map fills as you log training.</p>}</section><section className="panel training-card"><h2>Workout activity</h2>{stats.activity.length ? <ActivityChart stats={stats} /> : <p className="training-muted">Completed sessions will appear here.</p>}</section><section className="panel training-card"><h2>Exercise records</h2><p className="training-muted">Estimated 1RM uses sets of 1–12 reps. These are estimates, not tested maximums.</p><div className="training-records">{stats.records.map(record => <Link href={`/exercises/${encodeURIComponent(record.name)}`} key={record.name}><strong>{record.name}</strong><span>{record.bestWeightKg === null ? "Bodyweight" : `${round(record.bestWeightKg)} kg best load`}</span><span>{record.estimatedOneRepMax === null ? "No 1RM estimate" : `${record.estimatedOneRepMax} kg estimated 1RM`}</span><small>{record.sets} sets</small></Link>)}</div></section></>}
    {tab === "weight" && weight && <><section className="metric-grid training-metrics weight-metrics">
        <Metric label="LATEST WEIGH-IN" value={latestWeight ? round(latestWeight.weightKg) : "—"} unit="kg" accent hint={latestWeight?.day ?? "No weigh-ins logged"} />
        <Metric label="WEIGHT CHANGE" value={latestWeight && firstWeight && weight.entries.length > 1 ? `${latestWeight.weightKg - firstWeight.weightKg > 0 ? "+" : ""}${round(latestWeight.weightKg - firstWeight.weightKg)}` : "—"} unit="kg" hint={weight.entries.length > 1 ? `${firstWeight?.day} to ${latestWeight?.day}` : "Needs two weigh-ins"} />
        <Metric label="WEIGHT GOAL" value={weight.goalKg ?? "—"} unit="kg" hint={weight.goalKg === null ? "No goal set" : "Your saved goal"} />
      </section><section className="panel training-card"><div className="panel-title"><h2>01 / WEIGHT HISTORY</h2><strong>{weight.entries.length} weigh-ins</strong></div><p className="training-muted">Weekly weigh-ins, shown on their recorded dates.</p>{weight.entries.length ? <WeightChart entries={weight.entries} goalKg={weight.goalKg} /> : <div className="training-empty"><h3>No weigh-ins logged</h3><p>Record your weekly weigh-in below.</p></div>}</section><div className="training-two-column"><form className="panel training-card" onSubmit={event => { event.preventDefault(); void write({ action: "weight", day: weighDay, data: { weightKg: Number(weighKg), notes: weighNotes } }); }}><div className="panel-title"><h2>02 / WEEKLY WEIGH-IN</h2><strong>kg</strong></div><p className="training-muted">Weigh once a week, using the same scales and time. Use the date you weighed yourself. To correct an entry, select it in the history below.</p><div className="training-field-row"><label>Date<input type="date" value={weighDay} onChange={event => setWeighDay(event.target.value)} max={today} required /></label><label>Weight (kg)<input type="number" min={20} max={400} step="0.1" value={weighKg} onChange={event => setWeighKg(event.target.value)} required /></label></div><label>Note (optional)<input value={weighNotes} onChange={event => setWeighNotes(event.target.value)} maxLength={500} placeholder="e.g. Sunday morning" /></label><button disabled={busy} className="training-button">Save weigh-in</button></form><form className="panel training-card" onSubmit={event => { event.preventDefault(); void write({ action: "goal", data: { goalKg: goalKg.trim() ? Number(goalKg) : null } }); }}><div className="panel-title"><h2>03 / WEIGHT GOAL</h2><strong>optional</strong></div><label>Goal weight (kg)<input type="number" min={20} max={400} step="0.1" value={goalKg} onChange={event => setGoalKg(event.target.value)} /></label><p className="training-muted">Leave blank to remove the goal line.</p><button disabled={busy} className="training-button secondary">Save goal</button></form></div><section className="panel training-card"><div className="panel-title"><h2>04 / RECORDED WEIGH-INS</h2><strong>Edit an entry</strong></div><div className="weight-history">{[...weight.entries].reverse().map(entry => <button type="button" disabled={busy} key={entry.day} onClick={() => { setWeighDay(entry.day); setWeighKg(String(entry.weightKg)); setWeighNotes(entry.notes); setMessage(`Editing ${entry.day}. Save the weigh-in to apply your correction.`); }}><span><strong>{entry.day}</strong><small>{entry.notes || "No note"}</small></span><strong>{round(entry.weightKg)} kg</strong><small>Edit</small></button>)}</div></section></>}
  </div>;
}
