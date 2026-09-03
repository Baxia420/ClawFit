import { DEFAULT_PRIMARY_USER_ID, type HealthRepository } from "@clawfit/db";

export async function seedDemoDataIfEmpty(repository: HealthRepository, userId: string = DEFAULT_PRIMARY_USER_ID) {
  try {
    const recent = await repository.listRecentMeals(userId, 1);
    if (recent.length > 0) return;
  } catch {
    // Continue if empty or uninitialized
  }

  console.log("[DEMO_SEED] Populating sample data for local dashboard demo...");

  // 1. Settings
  try {
    await repository.updateSettings(userId, {
      calorieTarget: 2200,
      proteinTargetG: 160,
      timezone: "Asia/Kuala_Lumpur",
      preferredUnits: "metric",
    });
  } catch (err) {
    console.warn("[DEMO_SEED] Could not update settings:", err);
  }

  const now = new Date();
  const daysAgo = (days: number, hour = 12, minute = 30) => {
    const d = new Date(now);
    d.setDate(d.getDate() - days);
    d.setHours(hour, minute, 0, 0);
    return d;
  };

  // 2. Today's Meals
  await repository.createMeal(userId, {
    label: "Rolled Oats with Whey, Blueberries & Chia Seeds",
    items: [
      { name: "Rolled Oats", portionDescription: "80g" },
      { name: "Whey Protein Isolate", portionDescription: "1 scoop (30g)" },
      { name: "Fresh Blueberries", portionDescription: "50g" },
      { name: "Chia Seeds", portionDescription: "10g" },
    ],
    calories: { best: 480, low: 450, high: 520 },
    macros: { proteinG: 38, carbsG: 62, fatG: 8, fiberG: 9 },
    confidence: "high",
    uncertaintyReasons: [],
    occurredAt: daysAgo(0, 8, 30),
    source: "text",
    rawUserText: "Bowl of oats with protein powder, blueberries and chia",
    idempotencyKey: "demo-meal-today-breakfast",
  });

  await repository.createMeal(userId, {
    label: "Grilled Chicken Breast, Jasmine Rice & Broccoli",
    items: [
      { name: "Chicken Breast", portionDescription: "200g grilled" },
      { name: "Jasmine Rice", portionDescription: "180g cooked" },
      { name: "Broccoli", portionDescription: "100g steamed with olive oil" },
    ],
    calories: { best: 620, low: 580, high: 680 },
    macros: { proteinG: 56, carbsG: 68, fatG: 12, fiberG: 5 },
    confidence: "high",
    uncertaintyReasons: ["cooking oil on broccoli"],
    occurredAt: daysAgo(0, 13, 0),
    source: "text",
    rawUserText: "Grilled chicken, white rice and broccoli for lunch",
    idempotencyKey: "demo-meal-today-lunch",
  });

  await repository.createMeal(userId, {
    label: "Greek Yogurt Bowl with Honey & Walnuts",
    items: [
      { name: "0% Greek Yogurt", portionDescription: "200g" },
      { name: "Wild Honey", portionDescription: "1 tbsp" },
      { name: "Walnuts", portionDescription: "15g" },
    ],
    calories: { best: 280, low: 260, high: 310 },
    macros: { proteinG: 22, carbsG: 25, fatG: 9, fiberG: 1 },
    confidence: "high",
    uncertaintyReasons: [],
    occurredAt: daysAgo(0, 16, 15),
    source: "text",
    rawUserText: "Greek yogurt snack with a spoon of honey and walnuts",
    idempotencyKey: "demo-meal-today-snack",
  });

  // 3. Historical Meals (for trend charts on /nutrition)
  const history = [
    { days: 1, label: "Salmon Fillet, Sweet Potato & Asparagus", best: 650, low: 610, high: 710, p: 48, c: 50, f: 22, text: "Salmon dinner" },
    { days: 1, label: "Scrambled Eggs on Sourdough with Avocado", best: 520, low: 480, high: 570, p: 26, c: 42, f: 26, text: "Eggs on toast with avocado" },
    { days: 1, label: "Protein Shake & Banana", best: 270, low: 250, high: 300, p: 28, c: 32, f: 3, text: "Post-workout shake and banana" },
    { days: 1, label: "Chicken Burrito Bowl", best: 710, low: 660, high: 780, p: 52, c: 75, f: 18, text: "Chipotle style chicken bowl" },

    { days: 2, label: "Protein French Toast", best: 490, low: 450, high: 540, p: 36, c: 58, f: 10, text: "Protein french toast" },
    { days: 2, label: "Beef Sirloin Steak with Roasted Potatoes", best: 750, low: 700, high: 820, p: 62, c: 48, f: 28, text: "Steak and potatoes dinner" },
    { days: 2, label: "Tuna Salad Wrap", best: 430, low: 390, high: 480, p: 38, c: 35, f: 14, text: "Tuna wrap for lunch" },
    { days: 2, label: "Cottage Cheese with Berries", best: 210, low: 190, high: 240, p: 24, c: 18, f: 4, text: "Evening snack" },

    { days: 3, label: "Overnight Oats with Peanut Butter", best: 540, low: 500, high: 590, p: 32, c: 62, f: 18, text: "Overnight oats breakfast" },
    { days: 3, label: "Teriyaki Chicken Rice Bowl", best: 680, low: 630, high: 740, p: 48, c: 78, f: 14, text: "Teriyaki chicken rice" },
    { days: 3, label: "Whey Protein & Rice Cakes", best: 240, low: 220, high: 270, p: 27, c: 26, f: 2, text: "Pre workout snack" },
    { days: 3, label: "Turkey Chili with Brown Rice", best: 620, low: 580, high: 670, p: 50, c: 65, f: 15, text: "Turkey chili" },

    { days: 4, label: "Eggs, Turkey Bacon & Whole Grain Toast", best: 510, low: 470, high: 560, p: 38, c: 38, f: 20, text: "Breakfast plate" },
    { days: 4, label: "Grilled Chicken Caesar Salad", best: 580, low: 520, high: 650, p: 46, c: 22, f: 32, text: "Caesar salad with chicken" },
    { days: 4, label: "Protein Smoothie Bowl", best: 390, low: 360, high: 430, p: 30, c: 48, f: 7, text: "Berry protein smoothie" },
    { days: 4, label: "Lean Ground Beef Pasta", best: 720, low: 670, high: 780, p: 54, c: 72, f: 22, text: "Beef pasta dinner" },

    { days: 5, label: "Egg White Omelet with Spinach & Feta", best: 380, low: 350, high: 420, p: 34, c: 12, f: 18, text: "Omelet breakfast" },
    { days: 5, label: "Roast Beef Sandwich on Ciabatta", best: 590, low: 540, high: 650, p: 42, c: 56, f: 20, text: "Beef sandwich lunch" },
    { days: 5, label: "Baked Cod with Quinoa & Asparagus", best: 490, low: 450, high: 540, p: 45, c: 48, f: 9, text: "Fish dinner" },
    { days: 5, label: "Casein Protein Pudding", best: 180, low: 160, high: 200, p: 25, c: 8, f: 2, text: "Night snack" },

    { days: 6, label: "Pancakes with Whey & Strawberry Compote", best: 560, low: 510, high: 620, p: 35, c: 72, f: 12, text: "Pancakes breakfast" },
    { days: 6, label: "Chicken Rice with Cucumber Salad", best: 640, low: 590, high: 700, p: 46, c: 68, f: 16, text: "Hainanese chicken rice" },
    { days: 6, label: "Roasted Pork Tenderloin with Herb Mash", best: 670, low: 620, high: 730, p: 52, c: 54, f: 22, text: "Pork tenderloin dinner" },
  ];

  for (let i = 0; i < history.length; i++) {
    const item = history[i]!;
    await repository.createMeal(userId, {
      label: item.label,
      items: [{ name: item.label, portionDescription: "1 serving" }],
      calories: { best: item.best, low: item.low, high: item.high },
      macros: { proteinG: item.p, carbsG: item.c, fatG: item.f, fiberG: 4 },
      confidence: "high",
      uncertaintyReasons: [],
      occurredAt: daysAgo(item.days, 12 + (i % 6), 0),
      source: "text",
      rawUserText: item.text,
      idempotencyKey: `demo-hist-meal-${item.days}-${i}`,
    });
  }

  // 4. Past Finished Workouts (must be completed before starting active workout)
  const pastWorkout2 = await repository.startWorkout(userId, {
    name: "Legs & Core",
    startedAt: daysAgo(3, 18, 0),
    idempotencyKey: "demo-past-workout-2",
  });
  await repository.addWorkoutSet(userId, pastWorkout2.workout.id, { exerciseName: "Barbell Back Squat", weightKg: 110, reps: 6, rpe: 8, idempotencyKey: "demo-set-sq-1" });
  await repository.addWorkoutSet(userId, pastWorkout2.workout.id, { exerciseName: "Barbell Back Squat", weightKg: 115, reps: 6, rpe: 8.5, idempotencyKey: "demo-set-sq-2" });
  await repository.addWorkoutSet(userId, pastWorkout2.workout.id, { exerciseName: "Romanian Deadlift", weightKg: 90, reps: 10, rpe: 8, idempotencyKey: "demo-set-rdl-1" });
  await repository.addWorkoutSet(userId, pastWorkout2.workout.id, { exerciseName: "Leg Press", weightKg: 180, reps: 12, rpe: 8.5, idempotencyKey: "demo-set-lp-1" });
  await repository.finishWorkout(userId, pastWorkout2.workout.id);

  const pastWorkout1 = await repository.startWorkout(userId, {
    name: "Back & Biceps Focus",
    startedAt: daysAgo(1, 17, 0),
    idempotencyKey: "demo-past-workout-1",
  });
  await repository.addWorkoutSet(userId, pastWorkout1.workout.id, { exerciseName: "Barbell Deadlift", weightKg: 140, reps: 5, rpe: 8, idempotencyKey: "demo-set-dl-1" });
  await repository.addWorkoutSet(userId, pastWorkout1.workout.id, { exerciseName: "Barbell Deadlift", weightKg: 150, reps: 5, rpe: 9, idempotencyKey: "demo-set-dl-2" });
  await repository.addWorkoutSet(userId, pastWorkout1.workout.id, { exerciseName: "Lat Pulldown", weightKg: 70, reps: 10, rpe: 8, idempotencyKey: "demo-set-lat-1" });
  await repository.addWorkoutSet(userId, pastWorkout1.workout.id, { exerciseName: "Lat Pulldown", weightKg: 75, reps: 8, rpe: 8.5, idempotencyKey: "demo-set-lat-2" });
  await repository.addWorkoutSet(userId, pastWorkout1.workout.id, { exerciseName: "Barbell Bicep Curl", weightKg: 35, reps: 10, rpe: 8, idempotencyKey: "demo-set-curl-1" });
  await repository.finishWorkout(userId, pastWorkout1.workout.id);

  // 5. Active Workout (Chest & Triceps)
  const activeWorkout = await repository.startWorkout(userId, {
    name: "Chest & Triceps (Hypertrophy)",
    startedAt: daysAgo(0, 15, 30),
    idempotencyKey: "demo-active-workout-1",
  });

  await repository.addWorkoutSet(userId, activeWorkout.workout.id, {
    exerciseName: "Barbell Bench Press",
    weightKg: 85,
    reps: 8,
    rpe: 8,
    idempotencyKey: "demo-set-bench-1",
  });
  await repository.addWorkoutSet(userId, activeWorkout.workout.id, {
    exerciseName: "Barbell Bench Press",
    weightKg: 90,
    reps: 6,
    rpe: 8.5,
    idempotencyKey: "demo-set-bench-2",
  });
  await repository.addWorkoutSet(userId, activeWorkout.workout.id, {
    exerciseName: "Barbell Bench Press",
    weightKg: 85,
    reps: 7,
    rpe: 9,
    idempotencyKey: "demo-set-bench-3",
  });

  await repository.addWorkoutSet(userId, activeWorkout.workout.id, {
    exerciseName: "Incline Dumbbell Press",
    weightKg: 30,
    reps: 10,
    rpe: 8,
    idempotencyKey: "demo-set-inc-1",
  });
  await repository.addWorkoutSet(userId, activeWorkout.workout.id, {
    exerciseName: "Incline Dumbbell Press",
    weightKg: 32,
    reps: 8,
    rpe: 9,
    idempotencyKey: "demo-set-inc-2",
  });

  await repository.addWorkoutSet(userId, activeWorkout.workout.id, {
    exerciseName: "Cable Chest Fly",
    weightKg: 20,
    reps: 12,
    rpe: 8,
    idempotencyKey: "demo-set-fly-1",
  });
  await repository.addWorkoutSet(userId, activeWorkout.workout.id, {
    exerciseName: "Cable Chest Fly",
    weightKg: 22.5,
    reps: 10,
    rpe: 9,
    idempotencyKey: "demo-set-fly-2",
  });

  // 6. Notification Preferences
  await repository.upsertNotificationPreference(userId, {
    type: "meal_reminder",
    enabled: true,
    timeLocal: "12:30",
    timezone: "Asia/Kuala_Lumpur",
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    deliveryChannel: "web_push",
    configuration: {},
  });
  await repository.upsertNotificationPreference(userId, {
    type: "evening_progress",
    enabled: true,
    timeLocal: "21:00",
    timezone: "Asia/Kuala_Lumpur",
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    deliveryChannel: "web_push",
    configuration: {},
  });

  console.log("[DEMO_SEED] Demo seed completed successfully.");
}
