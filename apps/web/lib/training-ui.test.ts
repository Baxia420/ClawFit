import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { summarizeTraining, muscleGroups, type MuscleGroup } from "@clawfit/health-core";
vi.mock("../auth", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { TrainingHub } from "../components/TrainingHub";
import { MuscleCoverage } from "../components/MuscleCoverage";
const base = { tab: "train" as const, date: "2026-10-11", today: "2026-10-11", days: 30, settings: { timezone: "Asia/Kuala_Lumpur", calorieTarget: 2300, proteinTargetG: 160 }, active: null, history: [], routines: [], schedule: [], stats: null, weight: null };
describe("training views", () => {
  it("renders useful empty states, full weekly scheduling and truthful zero-data stats", () => {
    expect(renderToStaticMarkup(createElement(TrainingHub, base))).toContain("Start blank workout");
    const plans = renderToStaticMarkup(createElement(TrainingHub, { ...base, tab: "plans" }));
    expect(plans).toContain("Create routine");
    expect(plans).toContain('aria-label="Sunday routine"');
    expect(plans).toContain('aria-label="Monday routine"');
    const stats = renderToStaticMarkup(createElement(TrainingHub, { ...base, tab: "stats", stats: summarizeTraining([], base.settings.timezone) }));
    expect(stats).toContain("No completed sessions in this window");
    expect(stats).toContain("Bodyweight load excluded");
    const weight = renderToStaticMarkup(createElement(TrainingHub, { ...base, tab: "weight", weight: { entries: [], goalKg: null } }));
    expect(weight).toContain("Add your first weigh-in below");
    expect(weight).toContain("Needs two weigh-ins");
    expect(weight).toContain("Saving that day again corrects its existing entry");
  });
  it("makes each muscle keyboard accessible and identifies the count as primary-muscle sets", () => {
    const counts = Object.fromEntries(muscleGroups.map(m => [m, m === "chest" ? 7 : 0])) as Record<MuscleGroup,number>;
    const html = renderToStaticMarkup(createElement(MuscleCoverage, { counts }));
    expect(html).toContain('aria-label="Chest: 7 sets"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("counts each set once");
    expect(html).toContain("Unclassified");
  });
});
