export type AssistantMeal = {
  id: string;
  label: string;
  caloriesBest: number;
  caloriesLow: number;
  caloriesHigh: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number | null;
  confidence: "high" | "medium" | "low";
  uncertaintyReasons: string[];
  confirmed?: boolean;
  cancelledAt?: string | null;
};

export type AssistantWorkout = {
  workout: { id: string; name: string; status: string; startedAt: string };
  exercises: {
    id: string;
    name: string;
    sets: { id: string; setNumber: number; weightKg: number | null; reps: number; occurredAt?: string }[];
  }[];
  volumeKg: number;
  setCount: number;
};

export type AssistantResult = {
  kind: "message" | "meal_draft" | "meal_logged" | "nutrition" | "workout" | "set_logged" | "exercise";
  message: string;
  meal?: AssistantMeal;
  workout?: AssistantWorkout;
  nutrition?: {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    mealCount: number;
  };
  exercise?: { name: string; bestWeightKg: number; bestEstimatedOneRepMaxKg: number; setCount: number };
};
