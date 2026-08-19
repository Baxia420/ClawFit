"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import type { AssistantMeal, AssistantResult } from "../lib/assistant-types";

type ChatMessage = { id: string; role: "user" | "assistant"; text: string; result?: AssistantResult };

const starter: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text: "I can estimate meals, check nutrition, and log your active workout. Your Health API—not this chat—is the record.",
};

export function AssistantDrawer() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([starter]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  function openDrawer(prompt?: string) {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    if (prompt) setMessage(prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function closeDrawer() {
    setOpen(false);
    requestAnimationFrame(() => openerRef.current?.focus());
  }

  useEffect(() => {
    const listener = (event: Event) => {
      const prompt = (event as CustomEvent<{ prompt?: string }>).detail?.prompt;
      openDrawer(prompt);
    };
    window.addEventListener("clawfit:ask", listener);
    return () => window.removeEventListener("clawfit:ask", listener);
  }, []);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const background = [...document.querySelectorAll<HTMLElement>(".rail, main, .mobile-nav, .assistant-fab")];
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')]
        .filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = "hidden";
    background.forEach((element) => { element.inert = true; });
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      document.body.style.overflow = previousOverflow;
      background.forEach((element) => { element.inert = false; });
      window.removeEventListener("keydown", handleKeyboard);
    };
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if ((!text && !image) || busy) return;
    const requestId = crypto.randomUUID();
    setMessages((current) => [...current, { id: requestId, role: "user", text: text || `Food photo: ${image?.name ?? "image"}` }]);
    setMessage("");
    setError("");
    setBusy(true);
    try {
      let response: Response;
      if (image) {
        const data = new FormData();
        data.set("message", text);
        data.set("requestId", requestId);
        data.set("image", image);
        response = await fetch("/api/assistant", { method: "POST", body: data });
      } else {
        response = await fetch("/api/assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "command", message: text, requestId }),
        });
      }
      const payload = (await response.json()) as AssistantResult & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Request failed");
      appendResult(payload);
      if (["meal_logged", "workout", "set_logged"].includes(payload.kind)) router.refresh();
      setImage(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function mealAction(action: "confirm" | "cancel" | "edit", pendingId: string, patch?: Record<string, string | number>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, pendingId, ...(patch ? { patch } : {}) }),
      });
      const payload = (await response.json()) as AssistantResult & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Request failed");
      appendResult(payload);
      if (action === "confirm") router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function appendResult(result: AssistantResult) {
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: result.message, result }]);
  }

  return (
    <>
      <button className="assistant-fab" type="button" onClick={() => openDrawer()} aria-label="Open Ask ClawFit">
        <span>ASK</span><strong>+</strong>
      </button>
      {open && <button className="assistant-scrim" type="button" aria-label="Close assistant" onClick={closeDrawer} />}
      <aside ref={drawerRef} className={`assistant-drawer ${open ? "is-open" : ""}`} role="dialog" aria-modal="true" aria-label="Ask ClawFit" aria-hidden={!open}>
        <header className="assistant-head">
          <div><span>CLAWFIT / AI</span><strong>Ask ClawFit</strong></div>
          <button type="button" onClick={closeDrawer} aria-label="Close assistant">×</button>
        </header>
        <div className="assistant-status"><i /> HEALTH API BOUNDARY <span>SERVER-SIDE ONLY</span></div>
        <div className="assistant-feed" aria-live="polite">
          {messages.map((item) => <ChatBubble key={item.id} item={item} busy={busy} onMealAction={mealAction} />)}
          {busy && <div className="chat-bubble assistant"><span className="typing">ESTIMATING / LOGGING</span></div>}
          <div ref={endRef} />
        </div>
        <div className="prompt-chips" aria-label="Suggested prompts">
          {["What did I eat today?", "starting push", "What have I done this workout?"].map((prompt) => <button type="button" key={prompt} onClick={() => setMessage(prompt)}>{prompt}</button>)}
        </div>
        <form className="assistant-compose" onSubmit={submit}>
          {image && <div className="image-chip"><span>{image.name}</span><button type="button" onClick={() => setImage(null)}>Remove</button></div>}
          {error && <p className="assistant-error" role="alert">{error}</p>}
          <div className="compose-row">
            <label className="photo-button" aria-label="Attach a food photo">
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" onChange={(event) => setImage(event.target.files?.[0] ?? null)} />
              <span>PHOTO</span>
            </label>
            <input ref={inputRef} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Meal, set, or question…" maxLength={4000} />
            <button className="send-button" type="submit" disabled={busy || (!message.trim() && !image)}>SEND</button>
          </div>
          <small>Nutrition is estimated. Meals remain drafts until you confirm.</small>
        </form>
      </aside>
    </>
  );
}

function ChatBubble({ item, busy, onMealAction }: { item: ChatMessage; busy: boolean; onMealAction: (action: "confirm" | "cancel" | "edit", id: string, patch?: Record<string, string | number>) => Promise<void> }) {
  return <div className={`chat-bubble ${item.role}`}><span className="chat-role">{item.role === "assistant" ? "CF /" : "YOU /"}</span><p>{item.text}</p>{item.result?.meal && item.result.kind === "meal_draft" && <MealDraft meal={item.result.meal} busy={busy} onAction={onMealAction} />}{item.result?.nutrition && <NutritionReadout result={item.result} />}{item.result?.workout && <WorkoutReadout workout={item.result.workout} />}{item.result?.exercise && <ExerciseReadout result={item.result} />}</div>;
}

function MealDraft({ meal, busy, onAction }: { meal: AssistantMeal; busy: boolean; onAction: (action: "confirm" | "cancel" | "edit", id: string, patch?: Record<string, string | number>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ label: meal.label, caloriesBest: meal.caloriesBest, caloriesLow: meal.caloriesLow, caloriesHigh: meal.caloriesHigh, proteinG: meal.proteinG, carbsG: meal.carbsG, fatG: meal.fatG });
  return <article className="estimate-card">
    <header><span>DRAFT / {meal.confidence}</span><strong>{meal.label}</strong></header>
    {editing ? <div className="estimate-edit">
      <label>Meal name<input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
      {(["caloriesBest", "proteinG", "carbsG", "fatG"] as const).map((field) => <label key={field}>{field === "caloriesBest" ? "Calories" : field.replace("G", " (g)")}<input type="number" min="0" value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: Number(event.target.value) })} /></label>)}
      <button type="button" disabled={busy} onClick={() => { void onAction("edit", meal.id, draft); setEditing(false); }}>SAVE EDIT</button>
    </div> : <>
      <div className="estimate-energy"><strong>{meal.caloriesBest}</strong><span>{meal.caloriesLow}–{meal.caloriesHigh} KCAL</span></div>
      <div className="estimate-macros"><span><b>{Math.round(meal.proteinG)}</b> P</span><span><b>{Math.round(meal.carbsG)}</b> C</span><span><b>{Math.round(meal.fatG)}</b> F</span></div>
      {meal.uncertaintyReasons.length > 0 && <small>{meal.uncertaintyReasons.join(" · ")}</small>}
    </>}
    <footer><button type="button" className="log-meal" disabled={busy} onClick={() => void onAction("confirm", meal.id)}>LOG MEAL</button><button type="button" disabled={busy} onClick={() => setEditing((value) => !value)}>EDIT</button><button type="button" disabled={busy} onClick={() => void onAction("cancel", meal.id)}>CANCEL</button></footer>
  </article>;
}

function NutritionReadout({ result }: { result: AssistantResult }) {
  const nutrition = result.nutrition!;
  return <div className="assistant-readout"><span><b>{nutrition.calories}</b> KCAL</span><span><b>{nutrition.proteinG}</b> PROTEIN</span><span><b>{nutrition.mealCount}</b> DAYS / MEALS</span></div>;
}

function WorkoutReadout({ workout }: { workout: NonNullable<AssistantResult["workout"]> }) {
  return <div className="assistant-workout"><header><strong>{workout.workout.name}</strong><span>{workout.setCount} SETS</span></header>{workout.exercises.map((exercise) => <div key={exercise.id}><b>{exercise.name}</b><span>{exercise.sets.map((set) => `${set.weightKg ?? "BW"}×${set.reps}`).join(" / ")}</span></div>)}</div>;
}

function ExerciseReadout({ result }: { result: AssistantResult }) {
  const exercise = result.exercise!;
  return <div className="assistant-readout"><span><b>{exercise.bestWeightKg}</b> KG</span><span><b>{exercise.bestEstimatedOneRepMaxKg}</b> E1RM</span><span><b>{exercise.setCount}</b> SETS</span></div>;
}
