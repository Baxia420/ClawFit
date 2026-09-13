"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  scaleNutritionItem,
  applyItemPortionDelta,
  formatAdjustedPortionDescription,
  zonedTimeToUtc,
  getZonedCalendarDate,
  getZonedTimeString,
  hasItemNutrients,
  type Confidence,
} from "@clawfit/health-core";

import {
  type MealDraft,
  serializeMealContext,
  parseAuthoritativeDraft,
} from "../lib/meal-flow-helpers";

type PresetItem = {
  id: string;
  name: string;
  label: string;
  caloriesBest: number;
  caloriesLow: number;
  caloriesHigh: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number | null;
  confidence: Confidence;
};

export function MealLogFlow({ timezone = "Asia/Kuala_Lumpur" }: { timezone?: string }) {
  const router = useRouter();

  // Mode: "ai" | "manual"
  const [mode, setMode] = useState<"ai" | "manual">("ai");

  // Input states
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<{ file: File; dataUrl: string; base64: string } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Date and Time (defaults to user profile timezone)
  const [date, setDate] = useState(() => getZonedCalendarDate(new Date(), timezone));
  const [time, setTime] = useState(() => getZonedTimeString(new Date(), timezone));

  // Presets state
  const [presetSearch, setPresetSearch] = useState("");
  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [searchingPresets, setSearchingPresets] = useState(false);

  type MutationState = "idle" | "estimating" | "revising" | "scaling" | "syncing_meta" | "saving" | "cancelling";

  type ConfirmedMealSummary = {
    id: string;
    label: string;
    caloriesBest: number;
    proteinG: number;
    occurredAt: string;
  };

  // Flow & review states
  const [operationId, setOperationId] = useState(() => `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
  const [draft, setDraft] = useState<MealDraft | null>(null);
  const [mutationState, setMutationState] = useState<MutationState>("idle");
  const [confirmedMeal, setConfirmedMeal] = useState<ConfirmedMealSummary | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revisionText, setRevisionText] = useState("");
  const [revisionHistory, setRevisionHistory] = useState<string[]>([]);

  // Computed state flags
  const isBusy = mutationState !== "idle" || compressing;
  const estimating = mutationState === "estimating";
  const revising = mutationState === "revising";
  const mutating = mutationState === "scaling" || mutationState === "revising" || mutationState === "syncing_meta";
  const saving = mutationState === "saving";

  // Concurrency & token fencing refs
  const requestTokenRef = useRef(0);
  const inFlightControllerRef = useRef<AbortController | null>(null);
  const lastRevisionPromptRef = useRef<string | null>(null);
  const lastRevisionOpIdRef = useRef<string | null>(null);
  const manualCreationRef = useRef<{ key: string; fingerprint: string } | null>(null);
  const presetCreationRef = useRef<{ key: string; fingerprint: string } | null>(null);
  const aiCreationRef = useRef<{ key: string; fingerprint: string } | null>(null);
  const isMetaDirtyRef = useRef(false);
  const draftRef = useRef<MealDraft | null>(null);
  draftRef.current = draft;
  const textRef = useRef("");
  textRef.current = text;
  const photoRef = useRef<typeof photo>(null);
  photoRef.current = photo;

  const lastSyncedMetaRef = useRef<{ date: string; time: string; notes: string; text: string; revisionHistoryLen: number }>({
    date,
    time,
    notes: "",
    text: "",
    revisionHistoryLen: 0,
  });

  // Reconcile complete authoritative state (items, totals, ranges, context, version, lifecycle status)
  async function reconcileAuthoritativeDraft(draftId: string): Promise<MealDraft | null> {
    try {
      const authRes = await fetch(`/api/meals/pending/${draftId}`);
      if (!authRes.ok) return null;
      const authData = await authRes.json();
      const p = (authData.pending ?? authData) as Record<string, unknown>;
      const auth = parseAuthoritativeDraft(p);

      if (auth.confirmed) {
        setConfirmedMeal({
          id: auth.draft.id!,
          label: auth.draft.label,
          caloriesBest: auth.draft.calories.best,
          proteinG: auth.draft.macros.proteinG,
          occurredAt: String(p.occurredAt || new Date().toISOString()),
        });
        setDraft(auth.draft);
        setSavedSuccess(true);
        return auth.draft;
      }

      if (auth.cancelled) {
        setDraft(null);
        setError("This meal draft was cancelled on the server.");
        return null;
      }

      setDraft(auth.draft);

      if (auth.context.text) setText(auth.context.text);
      if (auth.context.notes) setNotes(auth.context.notes);
      if (auth.context.revisionHistory.length > 0) {
        setRevisionHistory(auth.context.revisionHistory);
      }

      if (p.occurredAt) {
        const d = new Date(String(p.occurredAt));
        const recDate = getZonedCalendarDate(d, timezone);
        const recTime = getZonedTimeString(d, timezone);
        setDate(recDate);
        setTime(recTime);
        lastSyncedMetaRef.current = {
          date: recDate,
          time: recTime,
          notes: auth.context.notes,
          text: auth.context.text,
          revisionHistoryLen: auth.context.revisionHistory.length,
        };
      }

      isMetaDirtyRef.current = false;
      return auth.draft;
    } catch {
      return null;
    }
  }

  // Input change handlers marking metadata dirty
  function handleDateChange(val: string) {
    setDate(val);
    isMetaDirtyRef.current = true;
  }
  function handleTimeChange(val: string) {
    setTime(val);
    isMetaDirtyRef.current = true;
  }
  function handleNotesChange(val: string) {
    setNotes(val);
    isMetaDirtyRef.current = true;
  }
  function handleTextChange(val: string) {
    setText(val);
    isMetaDirtyRef.current = true;
  }

  // Manual entry fields
  const [manualLabel, setManualLabel] = useState("");
  const [manualCalories, setManualCalories] = useState("500");
  const [manualProtein, setManualProtein] = useState("30");
  const [manualCarbs, setManualCarbs] = useState("45");
  const [manualFat, setManualFat] = useState("15");
  const [manualFiber, setManualFiber] = useState("5");

  // Recover unconfirmed pending draft on mount without re-running inference
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const token = ++requestTokenRef.current;

    async function recoverPending() {
      try {
        const res = await fetch("/api/meals/pending", { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { pending?: Record<string, unknown> | null };
        if (!mounted || !data?.pending || token !== requestTokenRef.current) return;
        // Never overwrite if user already has an active draft or typed input
        if (draftRef.current !== null || textRef.current.trim() !== "" || photoRef.current !== null) return;

        const p = data.pending;
        if (p.confirmed || p.cancelledAt) return;

        const auth = parseAuthoritativeDraft(p);
        setDraft(auth.draft);

        // Recover serialized context (text, notes, revision history)
        if (auth.context.text) setText(auth.context.text);
        if (auth.context.notes) setNotes(auth.context.notes);
        if (auth.context.revisionHistory.length > 0) setRevisionHistory(auth.context.revisionHistory);

        // Recover date and time in user timezone
        let recoveredDate = date;
        let recoveredTime = time;
        if (p.occurredAt) {
          const d = new Date(String(p.occurredAt));
          recoveredDate = getZonedCalendarDate(d, timezone);
          recoveredTime = getZonedTimeString(d, timezone);
          setDate(recoveredDate);
          setTime(recoveredTime);
        }

        isMetaDirtyRef.current = false;
        lastSyncedMetaRef.current = {
          date: recoveredDate,
          time: recoveredTime,
          notes: auth.context.notes,
          text: auth.context.text,
          revisionHistoryLen: auth.context.revisionHistory.length,
        };
      } catch {
        // Recovery failure is non-blocking
      }
    }

    void recoverPending();
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [timezone]);

  // Debounced background sync of date, time, notes, and text changes to active pending draft
  useEffect(() => {
    if (!draft?.id || isBusy || !isMetaDirtyRef.current) return;
    const currentDraftId = draft.id;
    const currentVersion = draft.version;

    const timer = setTimeout(async () => {
      if (mutationState !== "idle" || !isMetaDirtyRef.current) return;
      try {
        setMutationState("syncing_meta");
        const occurredAt = zonedTimeToUtc(date, time, timezone).toISOString();
        const rawUserText = serializeMealContext(text, notes, revisionHistory);

        const res = await fetch(`/api/meals/pending/${currentDraftId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            occurredAt,
            rawUserText,
            expectedVersion: currentVersion,
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as { version?: number };
          const newVersion = data?.version;
          if (typeof newVersion === "number") {
            setDraft((prev) => (prev && prev.id === currentDraftId ? { ...prev, version: newVersion } : prev));
          }
          isMetaDirtyRef.current = false;
          lastSyncedMetaRef.current = {
            date,
            time,
            notes,
            text,
            revisionHistoryLen: revisionHistory.length,
          };
        } else if (res.status === 409) {
          // Reconcile complete authoritative state from server
          await reconcileAuthoritativeDraft(currentDraftId);
        }
      } catch {
        // Debounced sync failure keeps dirty state intact
      } finally {
        setMutationState("idle");
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [date, time, notes, text, revisionHistory, draft?.id, draft?.version, isBusy, mutationState, timezone]);

  // Search presets debounce
  useEffect(() => {
    if (!presetSearch.trim()) {
      setPresets([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchingPresets(true);
      try {
        const res = await fetch(`/api/food-presets?query=${encodeURIComponent(presetSearch.trim())}`);
        if (res.ok) {
          const data = (await res.json()) as { presets?: PresetItem[] } | PresetItem[];
          setPresets(Array.isArray(data) ? data : data.presets ?? []);
        }
      } catch {
        // Preset search failure non-blocking
      } finally {
        setSearchingPresets(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [presetSearch]);

  // Client-side canvas compression for photos with secondary downscale and HEIC handling
  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    if (file.type === "image/heic" || /\.heic$/i.test(file.name)) {
      setError("HEIC photos are not supported directly by your browser. Please convert the photo to JPEG or PNG before uploading.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Please choose a JPEG, PNG, or WebP photo.");
      return;
    }

    setCompressing(true);
    try {
      let compressed = await compressImage(file, 1600, 0.80);
      const MAX_PAYLOAD_BYTES = 3.5 * 1024 * 1024; // 3.5 MB request limit

      if (compressed.base64.length > MAX_PAYLOAD_BYTES) {
        compressed = await compressImage(file, 1200, 0.70);
      }
      if (compressed.base64.length > MAX_PAYLOAD_BYTES) {
        compressed = await compressImage(file, 900, 0.60);
      }
      if (compressed.base64.length > MAX_PAYLOAD_BYTES) {
        throw new Error("Photo is too large to upload even after compression. Please choose a smaller photo.");
      }

      setPhoto({ file, dataUrl: compressed.dataUrl, base64: compressed.base64 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process photo");
      setPhoto(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setCompressing(false);
    }
  }

  function removePhoto() {
    setPhoto(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Explicitly flush dirty metadata (notes, date, time, rawUserText) and await acknowledgment before confirm
  async function flushPendingMetadata(activeDraft: MealDraft): Promise<MealDraft> {
    if (!isMetaDirtyRef.current || !activeDraft.id) {
      return activeDraft;
    }

    const occurredAt = zonedTimeToUtc(date, time, timezone).toISOString();
    const rawUserText = serializeMealContext(text, notes, revisionHistory);

    let res: Response;
    try {
      res = await fetch(`/api/meals/pending/${activeDraft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurredAt,
          rawUserText,
          expectedVersion: activeDraft.version,
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Draft was updated on the server")) {
        throw err;
      }
      const reconciled = await reconcileAuthoritativeDraft(activeDraft.id);
      if (reconciled && reconciled.version > activeDraft.version) {
        throw new Error("Draft was updated on the server. Please review the updated draft before continuing.");
      }
      throw new Error("Unable to synchronize metadata before confirmation. Please retry.");
    }

    if (!res.ok) {
      if (res.status === 409) {
        await reconcileAuthoritativeDraft(activeDraft.id);
        throw new Error("Draft was updated on the server. Please review the updated draft before continuing.");
      }
      throw new Error("Unable to synchronize metadata before confirmation. Please retry.");
    }

    const data = (await res.json()) as { version?: number };
    const newVersion = typeof data.version === "number" ? data.version : activeDraft.version + 1;
    const flushed: MealDraft = { ...activeDraft, version: newVersion };
    setDraft(flushed);
    isMetaDirtyRef.current = false;
    lastSyncedMetaRef.current = {
      date,
      time,
      notes,
      text,
      revisionHistoryLen: revisionHistory.length,
    };
    return flushed;
  }

  // Ensure draft is saved to server pending meals and returns updated draft
  async function ensurePendingDraft(currentDraft: MealDraft): Promise<MealDraft> {
    if (currentDraft.id) return currentDraft;

    const occurredAt = zonedTimeToUtc(date, time, timezone).toISOString();
    const rawUserText = serializeMealContext(text, notes, revisionHistory);
    const idempotencyKey = currentDraft.operationId.startsWith("draft_")
      ? currentDraft.operationId
      : `draft_${currentDraft.operationId}`;

    const res = await fetch("/api/meals/pending", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: currentDraft.label,
        items: currentDraft.items,
        calories: currentDraft.calories,
        macros: currentDraft.macros,
        confidence: currentDraft.confidence,
        uncertaintyReasons: currentDraft.uncertaintyReasons,
        source: currentDraft.source,
        rawUserText,
        occurredAt,
        idempotencyKey,
      }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error?.message || errorData.error || "Failed to initialize meal draft on server.");
    }

    const created = await res.json();
    const hydrated: MealDraft = {
      ...currentDraft,
      id: created.id,
      version: typeof created.version === "number" ? created.version : 1,
      saveKey: `confirm_${created.id}`,
    };
    setDraft(hydrated);
    isMetaDirtyRef.current = false;
    lastSyncedMetaRef.current = { date, time, notes, text, revisionHistoryLen: revisionHistory.length };
    return hydrated;
  }

  // Run AI Estimation with contextual revisions, generation token fencing, and stable retry IDs
  async function handleEstimate(isRevision = false) {
    if (isBusy) return;
    if (!isRevision && !text.trim() && !photo) {
      setError("Please describe your meal or attach a photo to estimate nutrition.");
      return;
    }

    setError(null);
    setMutationState(isRevision ? "revising" : "estimating");

    const token = ++requestTokenRef.current;

    // Stable operation ID on revision retry: reuse ID if revision text didn't change
    let currentOpId: string;
    if (isRevision) {
      const revPrompt = revisionText.trim();
      if (lastRevisionPromptRef.current === revPrompt && lastRevisionOpIdRef.current) {
        currentOpId = lastRevisionOpIdRef.current;
      } else {
        currentOpId = `op_rev_${draft?.id ?? "draft"}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        lastRevisionPromptRef.current = revPrompt;
        lastRevisionOpIdRef.current = currentOpId;
      }
    } else {
      currentOpId = operationId;
    }

    // Rich contextual prompt preserving structured draft and previous preparation details
    let queryText = "";
    if (isRevision && draft) {
      const itemsSummary = draft.items.length > 0
        ? draft.items.map((it) => `${it.name} (${it.portionDescription}${it.calories ? `: ${it.calories} kcal` : ""})`).join(", ")
        : draft.label;
      const parts = [
        `Base meal: "${text.trim() || draft.label}"`,
        draft.items.length > 0 ? `Current structured draft: [${itemsSummary}] with total estimated calories: ${draft.calories.best} kcal` : `Current label: "${draft.label}"`,
        notes.trim() ? `Preparation notes: "${notes.trim()}"` : null,
        revisionHistory.length > 0 ? `Prior revisions applied: ${revisionHistory.join("; ")}` : null,
        `Requested revision: "${revisionText.trim()}"`,
        `Instruction: Adjust quantities or items to incorporate this requested revision while preserving untouched food items and preparation details.`
      ].filter(Boolean);
      queryText = parts.join(". ");
    } else {
      queryText = [text.trim(), notes.trim()].filter(Boolean).join(". Preparation: ");
    }

    if (inFlightControllerRef.current) {
      inFlightControllerRef.current.abort();
    }
    const abortCtrl = new AbortController();
    inFlightControllerRef.current = abortCtrl;

    try {
      const payload: Record<string, unknown> = {
        operationId: currentOpId,
        text: queryText,
      };

      if (photo) {
        payload.image = {
          mimeType: "image/jpeg",
          base64: photo.base64,
        };
      }

      const res = await fetch("/api/meals/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: abortCtrl.signal,
      });

      if (token !== requestTokenRef.current) return;

      const data = await res.json();
      if (token !== requestTokenRef.current) return;

      if (!res.ok) {
        const errorMsg = data.error?.message || data.error || "Estimation service unavailable";
        setError(`${errorMsg} You can enter details manually below.`);
        return;
      }

      const est = data.estimate ?? data;
      const occurredAt = zonedTimeToUtc(date, time, timezone).toISOString();
      const nextRevisionHistory = isRevision && revisionText.trim() ? [...revisionHistory, revisionText.trim()] : revisionHistory;
      const rawUserText = serializeMealContext(text, notes, nextRevisionHistory);

      let pendingRecordId = draft?.id;
      let nextVersion = draft?.version ?? 1;

      if (!pendingRecordId) {
        const aiFingerprint = JSON.stringify({
          text: text.trim(),
          notes: notes.trim(),
          hasPhoto: Boolean(photo),
          occurredAt,
        });
        let initialDraftKey: string;
        if (aiCreationRef.current && aiCreationRef.current.fingerprint === aiFingerprint) {
          initialDraftKey = aiCreationRef.current.key;
        } else {
          initialDraftKey = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          aiCreationRef.current = { key: initialDraftKey, fingerprint: aiFingerprint };
        }
        const draftKey = `draft_${initialDraftKey}`;
        const pendingRes = await fetch("/api/meals/pending", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...est,
            idempotencyKey: draftKey,
            source: photo ? "photo" : "text",
            rawUserText,
            occurredAt,
          }),
          signal: abortCtrl.signal,
        });
        if (token !== requestTokenRef.current) return;
        if (!pendingRes.ok) {
          const pErr = await pendingRes.json().catch(() => ({}));
          setError(pErr.error?.message || "Failed to persist initial draft to server.");
          return;
        }
        const pData = await pendingRes.json();
        pendingRecordId = pData.id;
        nextVersion = pData.version ?? 1;
      } else {
        const rawUserTextWithOp = serializeMealContext(text, notes, nextRevisionHistory, currentOpId);
        let patchRes: Response;
        try {
          patchRes = await fetch(`/api/meals/pending/${pendingRecordId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              label: est.label,
              items: est.items,
              caloriesBest: est.calories.best,
              caloriesLow: est.calories.low,
              caloriesHigh: est.calories.high,
              proteinG: est.macros.proteinG,
              carbsG: est.macros.carbsG,
              fatG: est.macros.fatG,
              fiberG: est.macros.fiberG,
              confidence: est.confidence,
              uncertaintyReasons: est.uncertaintyReasons,
              rawUserText: rawUserTextWithOp,
              occurredAt,
              expectedVersion: draft?.version,
            }),
            signal: abortCtrl.signal,
          });
        } catch (patchErr) {
          if ((patchErr as Error)?.name === "AbortError" || token !== requestTokenRef.current) return;
          try {
            const authRes = await fetch(`/api/meals/pending/${pendingRecordId}`);
            if (authRes.ok) {
              const authData = await authRes.json();
              const auth = parseAuthoritativeDraft(authData.pending ?? authData);
              if (auth.context.revisionOpId === currentOpId) {
                setDraft(auth.draft);
                setRevisionHistory(nextRevisionHistory);
                setRevisionText("");
                lastRevisionPromptRef.current = null;
                lastRevisionOpIdRef.current = null;
                return;
              } else {
                setDraft(auth.draft);
                setError("Revision could not be verified. Authoritative draft reloaded. Please review and retry your revision.");
                return;
              }
            }
          } catch {
            // fall through
          }
          setError("Network connection lost while persisting revision. Acknowledged draft preserved; please retry.");
          return;
        }

        if (token !== requestTokenRef.current) return;

        if (!patchRes.ok) {
          try {
            const authRes = await fetch(`/api/meals/pending/${pendingRecordId}`);
            if (authRes.ok) {
              const authData = await authRes.json();
              const auth = parseAuthoritativeDraft(authData.pending ?? authData);
              if (auth.context.revisionOpId === currentOpId) {
                setDraft(auth.draft);
                setRevisionHistory(nextRevisionHistory);
                setRevisionText("");
                lastRevisionPromptRef.current = null;
                lastRevisionOpIdRef.current = null;
                return;
              } else {
                setDraft(auth.draft);
                setError("Revision rejected due to draft version mismatch. Authoritative draft reloaded. Please review and retry your revision.");
                return;
              }
            } else {
              setError("Failed to persist revision to server. Acknowledged draft preserved; please retry.");
              return;
            }
          } catch {
            setError("Failed to persist revision to server. Acknowledged draft preserved; please retry.");
            return;
          }
        } else {
          const pData = await patchRes.json();
          nextVersion = typeof pData.version === "number" ? pData.version : ((draft?.version ?? 1) + 1);
        }
      }

      if (token !== requestTokenRef.current) return;

      if (isRevision && revisionText.trim()) {
        setRevisionHistory(nextRevisionHistory);
        setRevisionText("");
        lastRevisionPromptRef.current = null;
        lastRevisionOpIdRef.current = null;
      }

      setDraft({
        id: pendingRecordId,
        label: est.label,
        items: est.items ?? [],
        calories: est.calories ?? { best: 0, low: 0, high: 0 },
        macros: est.macros ?? { proteinG: 0, carbsG: 0, fatG: 0, fiberG: null },
        confidence: est.confidence ?? "medium",
        uncertaintyReasons: est.uncertaintyReasons ?? [],
        operationId: currentOpId,
        source: photo ? "photo" : "text",
        saveKey: pendingRecordId ? `confirm_${pendingRecordId}` : `confirm_${Date.now()}`,
        version: nextVersion,
      });
      isMetaDirtyRef.current = false;
      lastSyncedMetaRef.current = { date, time, notes, text, revisionHistoryLen: nextRevisionHistory.length };
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || token !== requestTokenRef.current) return;
      setError(err instanceof Error ? err.message : "Estimation failed. Please try manual entry.");
    } finally {
      if (token === requestTokenRef.current) {
        setMutationState("idle");
      }
    }
  }

  // Load preset into draft
  async function handleSelectPreset(preset: PresetItem) {
    if (isBusy) return;
    setMutationState("scaling");
    setError(null);

    try {
      const occurredAt = zonedTimeToUtc(date, time, timezone).toISOString();
      const rawUserText = serializeMealContext(`Preset: ${preset.name}`, notes, []);
      const fingerprint = JSON.stringify({
        presetId: preset.id,
        notes: notes.trim(),
        occurredAt,
      });

      let draftId: string;
      if (presetCreationRef.current && presetCreationRef.current.fingerprint === fingerprint) {
        draftId = presetCreationRef.current.key;
      } else {
        draftId = `preset_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        presetCreationRef.current = { key: draftId, fingerprint };
      }

      const newDraft: MealDraft = {
        label: preset.label || preset.name,
        items: [{ name: preset.name, portionDescription: "1 preset serving", calories: preset.caloriesBest, proteinG: preset.proteinG, carbsG: preset.carbsG, fatG: preset.fatG, fiberG: preset.fiberG }],
        calories: { best: preset.caloriesBest, low: preset.caloriesLow, high: preset.caloriesHigh },
        macros: { proteinG: preset.proteinG, carbsG: preset.carbsG, fatG: preset.fatG, fiberG: preset.fiberG },
        confidence: preset.confidence || "high",
        uncertaintyReasons: [],
        operationId: draftId,
        source: "preset",
        saveKey: `confirm_${draftId}`,
        version: 1,
      };

      const res = await fetch("/api/meals/pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...newDraft,
          occurredAt,
          idempotencyKey: `draft_${draftId}`,
          rawUserText,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setError(errData.error?.message || "Failed to initialize preset draft on server.");
        return;
      }

      const pData = await res.json();
      newDraft.id = pData.id;
      newDraft.version = typeof pData.version === "number" ? pData.version : 1;
      newDraft.saveKey = `confirm_${pData.id}`;

      setDraft(newDraft);
      setPresetSearch("");
      setPresets([]);
      isMetaDirtyRef.current = false;
      lastSyncedMetaRef.current = { date, time, notes, text: `Preset: ${preset.name}`, revisionHistoryLen: 0 };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize preset draft on server.");
    } finally {
      setMutationState("idle");
    }
  }

  // Scale portion of a single item arithmetically with delta calculation, awaiting server patch
  async function handleScaleItem(index: number, factor: number) {
    if (!draft || !draft.items[index] || isBusy) return;
    const oldItem = draft.items[index];
    if (!hasItemNutrients([oldItem])) {
      setError("Portion adjustment is unavailable for items lacking nutrient breakdown.");
      return;
    }

    setMutationState("scaling");
    setError(null);

    try {
      let activeDraft = draft;
      if (!activeDraft.id) {
        activeDraft = await ensurePendingDraft(activeDraft);
      }

      const draftId = activeDraft.id;
      if (!draftId) {
        setError("Unable to initialize draft on server.");
        return;
      }

      // Flush any dirty metadata first to ensure versions align
      if (isMetaDirtyRef.current) {
        activeDraft = await flushPendingMetadata(activeDraft);
      }

      const scaled = scaleNutritionItem(oldItem, factor);
      const updatedDesc = formatAdjustedPortionDescription(oldItem.portionDescription, factor);
      const newItem = { ...scaled, portionDescription: updatedDesc };

      const updatedItems = [...activeDraft.items];
      updatedItems[index] = newItem;

      // Apply delta to meal totals to keep untouched items and unitemized calories intact
      const updatedTotals = applyItemPortionDelta(activeDraft, oldItem, newItem);

      const occurredAt = zonedTimeToUtc(date, time, timezone).toISOString();
      const rawUserText = serializeMealContext(text, notes, revisionHistory);

      let res: Response;
      try {
        res = await fetch(`/api/meals/pending/${draftId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: updatedItems,
            caloriesBest: updatedTotals.calories.best,
            caloriesLow: updatedTotals.calories.low,
            caloriesHigh: updatedTotals.calories.high,
            proteinG: updatedTotals.macros.proteinG,
            carbsG: updatedTotals.macros.carbsG,
            fatG: updatedTotals.macros.fatG,
            fiberG: updatedTotals.macros.fiberG,
            occurredAt,
            rawUserText,
            expectedVersion: activeDraft.version,
          }),
        });
      } catch {
        const reconciled = await reconcileAuthoritativeDraft(draftId);
        if (reconciled && reconciled.version > activeDraft.version) {
          setError(`Portion adjustment committed on server (version ${reconciled.version}). Draft updated.`);
          return;
        }
        setError("Network connection lost while saving portion adjustment. Draft was kept in its previous state.");
        return;
      }

      if (!res.ok) {
        const reconciled = await reconcileAuthoritativeDraft(draftId);
        const errorData = await res.json().catch(() => ({}));
        const msg = errorData.error?.message || errorData.error || "Portion adjustment could not be saved to server.";
        if (reconciled && reconciled.version > activeDraft.version) {
          setError(`Portion adjustment already applied on server (version ${reconciled.version}). Draft updated.`);
        } else {
          setError(`Portion update failed: ${msg}. Authoritative draft reloaded.`);
        }
        return;
      }

      const updatedData = (await res.json()) as { version?: number };
      const nextVersion = typeof updatedData.version === "number" ? updatedData.version : activeDraft.version + 1;

      setDraft({
        ...activeDraft,
        items: updatedItems,
        calories: updatedTotals.calories,
        macros: updatedTotals.macros,
        version: nextVersion,
      });
      isMetaDirtyRef.current = false;
      lastSyncedMetaRef.current = { date, time, notes, text, revisionHistoryLen: revisionHistory.length };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Portion adjustment failed. Draft was kept in its previous state.");
    } finally {
      setMutationState("idle");
    }
  }

  // Build manual draft
  async function handleSaveManualDraft() {
    if (isBusy) return;
    setMutationState("scaling");
    setError(null);

    try {
      const caloriesNum = parseInt(manualCalories, 10) || 0;
      const proteinNum = parseFloat(manualProtein) || 0;
      const carbsNum = parseFloat(manualCarbs) || 0;
      const fatNum = parseFloat(manualFat) || 0;
      const fiberNum = manualFiber ? parseFloat(manualFiber) : null;
      const mealName = manualLabel.trim() || "Manual meal";
      const occurredAt = zonedTimeToUtc(date, time, timezone).toISOString();
      const rawUserText = serializeMealContext(mealName, notes, []);

      const fingerprint = JSON.stringify({
        label: mealName,
        calories: caloriesNum,
        protein: proteinNum,
        carbs: carbsNum,
        fat: fatNum,
        fiber: fiberNum,
        notes: notes.trim(),
        occurredAt,
      });

      let draftId: string;
      if (manualCreationRef.current && manualCreationRef.current.fingerprint === fingerprint) {
        draftId = manualCreationRef.current.key;
      } else {
        draftId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        manualCreationRef.current = { key: draftId, fingerprint };
      }

      const newDraft: MealDraft = {
        label: mealName,
        items: [{ name: mealName, portionDescription: "Custom portion", calories: caloriesNum, proteinG: proteinNum, carbsG: carbsNum, fatG: fatNum, fiberG: fiberNum }],
        calories: { best: caloriesNum, low: caloriesNum, high: caloriesNum },
        macros: { proteinG: proteinNum, carbsG: carbsNum, fatG: fatNum, fiberG: fiberNum },
        confidence: "high",
        uncertaintyReasons: [],
        operationId: draftId,
        source: "manual",
        saveKey: `confirm_${draftId}`,
        version: 1,
      };

      const res = await fetch("/api/meals/pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...newDraft,
          occurredAt,
          idempotencyKey: `draft_${draftId}`,
          rawUserText,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setError(errData.error?.message || "Failed to initialize manual draft on server.");
        return;
      }

      const pData = await res.json();
      newDraft.id = pData.id;
      newDraft.version = typeof pData.version === "number" ? pData.version : 1;
      newDraft.saveKey = `confirm_${pData.id}`;

      setDraft(newDraft);
      isMetaDirtyRef.current = false;
      lastSyncedMetaRef.current = { date, time, notes, text: mealName, revisionHistoryLen: 0 };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize manual draft on server.");
    } finally {
      setMutationState("idle");
    }
  }

  // Confirm and persist to database strictly through authenticated pending meal confirmation
  async function handleConfirmSave() {
    if (!draft || isBusy) return;
    setMutationState("saving");
    setError(null);

    try {
      let activeDraft = draft;
      if (!activeDraft.id) {
        activeDraft = await ensurePendingDraft(activeDraft);
      }

      // Explicitly flush dirty metadata and await acknowledgment before confirm runs
      activeDraft = await flushPendingMetadata(activeDraft);

      const draftId = activeDraft.id;
      if (!draftId) {
        throw new Error("Draft ID is required to confirm meal");
      }

      // Strictly convert wall-clock time in profile timezone to UTC
      const occurredAt = zonedTimeToUtc(date, time, timezone).toISOString();
      const saveIdempotencyKey = `confirm_${draftId}`;

      // Confirm strictly through authenticated pending meal flow with expectedVersion
      const res = await fetch(`/api/meals/pending/${draftId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurredAt,
          idempotencyKey: saveIdempotencyKey,
          expectedVersion: activeDraft.version,
        }),
      });

      if (!res.ok) {
        if (res.status === 409) {
          await reconcileAuthoritativeDraft(draftId);
          throw new Error("Draft was updated on the server. Please review the updated draft before confirming.");
        }
        const errorData = await res.json().catch(() => ({}));
        const msg = errorData.error?.message || errorData.error || "Save status could not be verified. You can safely retry confirming this meal.";
        throw new Error(msg);
      }

      const confirmedData = await res.json();
      const meal = (confirmedData.meal ?? confirmedData) as Record<string, unknown>;
      setConfirmedMeal({
        id: String(meal.id ?? activeDraft.id),
        label: String(meal.label ?? activeDraft.label),
        caloriesBest: Number(meal.caloriesBest ?? (meal.calories as any)?.best ?? activeDraft.calories.best),
        proteinG: Number(meal.proteinG ?? (meal.macros as any)?.proteinG ?? activeDraft.macros.proteinG),
        occurredAt: String(meal.occurredAt ?? occurredAt),
      });

      setSavedSuccess(true);
      router.refresh();
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : "Save status could not be verified. You can safely retry confirming this meal.";
      const cleanMsg = rawMsg.replace(/Nothing was changed\.?/i, "Status could not be verified; you can safely retry.");
      setError(cleanMsg);
    } finally {
      setMutationState("idle");
    }
  }

  function handleStartNewMeal() {
    requestTokenRef.current += 1;
    if (inFlightControllerRef.current) {
      inFlightControllerRef.current.abort();
      inFlightControllerRef.current = null;
    }

    setDraft(null);
    setConfirmedMeal(null);
    setText("");
    setNotes("");
    setPhoto(null);
    setOperationId(`op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    setSavedSuccess(false);
    setError(null);
    setRevisionHistory([]);
    setRevisionText("");
    lastRevisionPromptRef.current = null;
    lastRevisionOpIdRef.current = null;
    manualCreationRef.current = null;
    presetCreationRef.current = null;
    aiCreationRef.current = null;
    isMetaDirtyRef.current = false;
    setMutationState("idle");
    setDate(getZonedCalendarDate(new Date(), timezone));
    setTime(getZonedTimeString(new Date(), timezone));
    setManualLabel("");
    setManualCalories("500");
    setManualProtein("30");
    setManualCarbs("45");
    setManualFat("15");
    setManualFiber("5");
    setPresetSearch("");
    setPresets([]);
  }

  async function handleReset() {
    if (isBusy) return;
    setError(null);
    requestTokenRef.current += 1;
    if (inFlightControllerRef.current) {
      inFlightControllerRef.current.abort();
      inFlightControllerRef.current = null;
    }

    const draftToCancel = draft?.id;
    // Strictly do not cancel if draft is already confirmed or savedSuccess is true
    if (draftToCancel && !savedSuccess && !draft?.confirmed) {
      setMutationState("cancelling");
      try {
        const res = await fetch(`/api/meals/pending/${draftToCancel}`, { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
          const errData = await res.json().catch(() => ({}));
          setError(errData.error?.message || "Failed to discard draft on server. Please retry.");
          setMutationState("idle");
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to discard draft on server. Please retry.");
        setMutationState("idle");
        return;
      }
    }

    setDraft(null);
    setConfirmedMeal(null);
    setText("");
    setNotes("");
    setPhoto(null);
    setOperationId(`op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    setSavedSuccess(false);
    setError(null);
    setRevisionHistory([]);
    setRevisionText("");
    lastRevisionPromptRef.current = null;
    lastRevisionOpIdRef.current = null;
    manualCreationRef.current = null;
    presetCreationRef.current = null;
    aiCreationRef.current = null;
    isMetaDirtyRef.current = false;
    setMutationState("idle");
  }

  if (savedSuccess) {
    return (
      <div className="panel meal-saved-panel">
        <div className="panel-title">
          <span>MEAL CONFIRMED &middot; SAVED</span>
          <strong>RECORD UPDATED</strong>
        </div>
        <div className="meal-saved-body">
          <div className="meal-saved-badge">✓</div>
          <h2>{confirmedMeal?.label ?? draft?.label}</h2>
          <p>
            {confirmedMeal?.caloriesBest ?? draft?.calories.best} kcal &middot; {confirmedMeal?.proteinG ?? draft?.macros.proteinG}g protein &middot; Logged for {date} at {time}
          </p>
          <div className="meal-saved-actions">
            <Link href="/" className="quick-ask dark" style={{ textDecoration: "none", padding: "12px 24px" }}>
              VIEW DASHBOARD →
            </Link>
            <button type="button" onClick={() => handleStartNewMeal()} className="quick-ask secondary" style={{ padding: "12px 24px" }}>
              LOG ANOTHER MEAL
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="meal-log-container">
      {/* Date, Time and Mode Bar */}
      <div className="meal-log-meta-bar">
        <div className="meta-time-pickers">
          <label>
            <span>DATE</span>
            <input type="date" value={date} onChange={(e) => handleDateChange(e.target.value)} disabled={isBusy} />
          </label>
          <label>
            <span>TIME</span>
            <input type="time" value={time} onChange={(e) => handleTimeChange(e.target.value)} disabled={isBusy} />
          </label>
        </div>
        <div className="meta-mode-switch">
          <button
            type="button"
            className={mode === "ai" ? "active" : ""}
            onClick={() => { setMode("ai"); setError(null); }}
            disabled={isBusy}
          >
            AI ESTIMATOR
          </button>
          <button
            type="button"
            className={mode === "manual" ? "active" : ""}
            onClick={() => { setMode("manual"); setError(null); }}
            disabled={isBusy}
          >
            MANUAL ENTRY
          </button>
        </div>
      </div>

      {error && (
        <div className="meal-error-alert" role="alert">
          <strong>Notice:</strong> {error}
        </div>
      )}

      {!draft ? (
        mode === "ai" ? (
          <div className="panel meal-input-panel">
            <div className="panel-title">
              <span>01 / DESCRIBE OR PHOTOGRAPH</span>
              <strong>AI ESTIMATE</strong>
            </div>

            {/* Food Presets Search */}
            <div className="preset-search-row">
              <label htmlFor="preset-search-input">REUSE SAVED PRESET</label>
              <input
                id="preset-search-input"
                type="text"
                placeholder="Search your saved food presets..."
                value={presetSearch}
                onChange={(e) => setPresetSearch(e.target.value)}
                disabled={isBusy}
              />
              {searchingPresets && <small>Searching presets...</small>}
              {presets.length > 0 && (
                <div className="preset-dropdown">
                  {presets.map((p) => (
                    <button key={p.id} type="button" onClick={() => void handleSelectPreset(p)} disabled={isBusy}>
                      <strong>{p.name}</strong>
                      <span>{p.caloriesBest} kcal &middot; {p.proteinG}g P</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Description Text Input */}
            <div className="meal-field-row">
              <label htmlFor="meal-text-input">FOOD DESCRIPTION</label>
              <textarea
                id="meal-text-input"
                rows={3}
                placeholder="e.g. 2 fried eggs on sourdough with avocado and black coffee..."
                value={text}
                onChange={(e) => handleTextChange(e.target.value)}
                disabled={isBusy}
              />
            </div>

            {/* Portion / Preparation details */}
            <div className="meal-field-row">
              <label htmlFor="meal-notes-input">PORTION OR RESTAURANT DETAILS (OPTIONAL)</label>
              <input
                id="meal-notes-input"
                type="text"
                placeholder="e.g. restaurant serving, cooked in olive oil, large bowl..."
                value={notes}
                onChange={(e) => handleNotesChange(e.target.value)}
                disabled={isBusy}
              />
            </div>

            {/* Photo Upload with Canvas Compression */}
            <div className="meal-photo-section">
              <label className="photo-input-label">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  onChange={handleFileSelect}
                  disabled={compressing || isBusy}
                />
                <span>📷 {photo ? "REPLACE PHOTO" : "ADD MEAL PHOTO"}</span>
              </label>

              {compressing && <span className="compressing-indicator">Optimizing image size...</span>}

              {photo && (
                <div className="photo-preview-card">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.dataUrl} alt="Meal preview" />
                  <div className="photo-preview-meta">
                    <span>{photo.file.name} (optimized)</span>
                    <button type="button" onClick={removePhoto} disabled={isBusy}>Remove</button>
                  </div>
                </div>
              )}
            </div>

            {/* Explicit Estimate Action */}
            <div className="meal-action-footer">
              <button
                type="button"
                className="estimate-submit-btn"
                disabled={isBusy || (!text.trim() && !photo)}
                onClick={() => void handleEstimate(false)}
              >
                {estimating ? "ESTIMATING NUTRITION..." : "CALCULATE ESTIMATE →"}
              </button>
            </div>
          </div>
        ) : (
          /* Manual Entry Form */
          <div className="panel meal-input-panel">
            <div className="panel-title">
              <span>MANUAL ENTRY</span>
              <strong>DIRECT VALUES</strong>
            </div>

            <div className="meal-field-row">
              <label htmlFor="manual-label-input">MEAL LABEL / NAME</label>
              <input
                id="manual-label-input"
                type="text"
                placeholder="e.g. Protein shake with banana"
                value={manualLabel}
                onChange={(e) => setManualLabel(e.target.value)}
                disabled={isBusy}
              />
            </div>

            <div className="manual-macros-grid">
              <label htmlFor="manual-calories-input">
                <span>CALORIES (KCAL)</span>
                <input
                  id="manual-calories-input"
                  type="number"
                  min="0"
                  max="10000"
                  placeholder="e.g. 450"
                  value={manualCalories}
                  onChange={(e) => setManualCalories(e.target.value)}
                  disabled={isBusy}
                />
              </label>
              <label htmlFor="manual-protein-input">
                <span>PROTEIN (G)</span>
                <input
                  id="manual-protein-input"
                  type="number"
                  min="0"
                  max="1000"
                  placeholder="e.g. 35"
                  value={manualProtein}
                  onChange={(e) => setManualProtein(e.target.value)}
                  disabled={isBusy}
                />
              </label>
              <label htmlFor="manual-carbs-input">
                <span>CARBS (G)</span>
                <input
                  id="manual-carbs-input"
                  type="number"
                  min="0"
                  max="1000"
                  placeholder="e.g. 50"
                  value={manualCarbs}
                  onChange={(e) => setManualCarbs(e.target.value)}
                  disabled={isBusy}
                />
              </label>
              <label htmlFor="manual-fat-input">
                <span>FAT (G)</span>
                <input
                  id="manual-fat-input"
                  type="number"
                  min="0"
                  max="500"
                  placeholder="e.g. 10"
                  value={manualFat}
                  onChange={(e) => setManualFat(e.target.value)}
                  disabled={isBusy}
                />
              </label>
              <label htmlFor="manual-fiber-input">
                <span>FIBER (G, OPTIONAL)</span>
                <input
                  id="manual-fiber-input"
                  type="number"
                  min="0"
                  max="200"
                  placeholder="e.g. 5"
                  value={manualFiber}
                  onChange={(e) => setManualFiber(e.target.value)}
                  disabled={isBusy}
                />
              </label>
            </div>

            <div className="meal-action-footer">
              <button
                type="button"
                className="estimate-submit-btn"
                disabled={isBusy}
                onClick={() => void handleSaveManualDraft()}
              >
                REVIEW VALUES →
              </button>
            </div>
          </div>
        )
      ) : (
        /* Review & Confirmation Screen */
        <div className="panel meal-review-panel">
          <div className="panel-title">
            <span>02 / REVIEW &amp; CONFIRM</span>
            <strong>CONFIDENCE: {draft.confidence.toUpperCase()}</strong>
          </div>

          <div className="review-header">
            <h2>{draft.label}</h2>
            <div className="review-energy-hero">
              <strong>{Math.round(draft.calories.best)}</strong>
              <span>
                KCAL BEST ESTIMATE
                {draft.calories.low !== draft.calories.high && (
                  <small> (RANGE: {Math.round(draft.calories.low)}–{Math.round(draft.calories.high)} KCAL)</small>
                )}
              </span>
            </div>
          </div>

          {/* Macro Breakdown Chips */}
          <div className="review-macros-grid">
            <div className="macro-chip">
              <span>PROTEIN</span>
              <strong>{Math.round(draft.macros.proteinG * 10) / 10}g</strong>
            </div>
            <div className="macro-chip">
              <span>CARBS</span>
              <strong>{Math.round(draft.macros.carbsG * 10) / 10}g</strong>
            </div>
            <div className="macro-chip">
              <span>FAT</span>
              <strong>{Math.round(draft.macros.fatG * 10) / 10}g</strong>
            </div>
            <div className="macro-chip">
              <span>FIBER</span>
              <strong>{draft.macros.fiberG != null ? `${Math.round(draft.macros.fiberG * 10) / 10}g` : "—"}</strong>
            </div>
          </div>

          {/* Itemized Food Breakdown */}
          {draft.items.length > 0 && (
            <div className="review-items-list">
              <span className="items-kicker">FOOD ITEMS &amp; PORTIONS</span>
              {draft.items.map((item, idx) => (
                <div key={idx} className="review-item-row">
                  <div className="item-details">
                    <strong>{item.name}</strong>
                    <small>{item.portionDescription}</small>
                    {hasItemNutrients([item]) && (
                      <div className="item-nutrients-tag">
                        {item.calories != null && <span>{item.calories} kcal</span>}
                        {item.proteinG != null && <span>{item.proteinG}g P</span>}
                        {item.carbsG != null && <span>{item.carbsG}g C</span>}
                        {item.fatG != null && <span>{item.fatG}g F</span>}
                      </div>
                    )}
                  </div>
                  {hasItemNutrients([item]) ? (
                    <div className="item-scaling-controls">
                      <span className="scale-label">PORTION:</span>
                      <button
                        type="button"
                        title="Halve portion"
                        disabled={isBusy}
                        onClick={() => void handleScaleItem(idx, 0.5)}
                      >
                        ½x
                      </button>
                      <button
                        type="button"
                        title="Double portion"
                        disabled={isBusy}
                        onClick={() => void handleScaleItem(idx, 2.0)}
                      >
                        2x
                      </button>
                    </div>
                  ) : (
                    <div className="item-scaling-controls disabled">
                      <small className="item-scale-disabled-hint">Portion adjustment unavailable without item breakdown</small>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Preparation & Portion Notes (Visible & Editable on Review Screen) */}
          <div className="review-notes-box">
            <label htmlFor="meal-notes-input" className="notes-label">PREPARATION / PORTION NOTES</label>
            <input
              id="meal-notes-input"
              type="text"
              placeholder="Add preparation or portion notes (e.g. cooked in olive oil, extra garlic)..."
              value={notes}
              onChange={(e) => handleNotesChange(e.target.value)}
              disabled={isBusy}
              className="notes-input"
            />
          </div>

          {/* Uncertainty Reasons & Assumptions */}
          {draft.uncertaintyReasons.length > 0 && (
            <details className="uncertainty-details">
              <summary>Estimation assumptions &amp; uncertainty factors ({draft.uncertaintyReasons.length})</summary>
              <ul>
                {draft.uncertaintyReasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </details>
          )}

          {/* Contextual AI Revision */}
          <div className="review-refine-box">
            <label htmlFor="refine-input">NEED A REVISION? (e.g. “skinless chicken”, “more olive oil”)</label>
            <div className="refine-input-row">
              <input
                id="refine-input"
                type="text"
                placeholder="Describe adjustments (e.g. used oat milk, half portion of rice)..."
                value={revisionText}
                onChange={(e) => setRevisionText(e.target.value)}
                disabled={isBusy}
              />
              <button
                type="button"
                disabled={isBusy || !revisionText.trim()}
                onClick={() => void handleEstimate(true)}
              >
                {revising ? "UPDATING..." : "RE-ESTIMATE"}
              </button>
            </div>
          </div>

          {/* Confirm or Discard Actions */}
          <div className="review-confirm-footer">
            <button
              type="button"
              className="discard-btn"
              onClick={() => void handleReset()}
              disabled={isBusy}
            >
              {mutationState === "cancelling" ? "DISCARDING..." : "DISCARD"}
            </button>
            <button
              type="button"
              className="confirm-save-btn"
              onClick={() => void handleConfirmSave()}
              disabled={isBusy}
            >
              {saving ? "SAVING MEAL..." : mutating ? "UPDATING..." : "SAVE MEAL →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Helpers
async function compressImage(
  file: File,
  maxDimension = 1600,
  quality = 0.80,
): Promise<{ dataUrl: string; base64: string }> {
  return new Promise((resolve, reject) => {
    if (file.type === "image/heic" || /\.heic$/i.test(file.name)) {
      return reject(new Error("HEIC photos are not supported directly by your browser. Please convert the photo to JPEG or PNG before uploading."));
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to decode image. Please check the file format."));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas not supported"));
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const base64 = dataUrl.split(",")[1] ?? "";
        resolve({ dataUrl, base64 });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
