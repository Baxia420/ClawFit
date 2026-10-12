import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeTraining } from "@clawfit/health-core";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("training browser dependency boundary", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("renders every training tab without loading server authentication or secrets", async () => {
    // Deliberately do not mock ../auth: that hid the client dependency failure.
    for (const name of ["AUTH_SECRET", "NEXTAUTH_SECRET", "WEB_ASSERTION_SIGNING_SECRET", "HEALTH_API_AUTH_SECRET", "HEALTH_API_WEB_TOKEN", "NEXT_PHASE"]) vi.stubEnv(name, "");
    const { TrainingHub } = await import("../components/TrainingHub.jsx");
    const settings = { timezone: "Asia/Kuala_Lumpur", calorieTarget: 2300, proteinTargetG: 160 };
    const base = { date: "2026-10-12", today: "2026-10-12", days: 30, settings, active: null, history: [], routines: [], schedule: [], stats: summarizeTraining([], settings.timezone), weight: { entries: [], goalKg: null } };
    for (const tab of ["train", "plans", "stats", "weight"] as const) {
      const html = renderToStaticMarkup(createElement(TrainingHub, { ...base, tab }));
      expect(html).toContain("Workout");
      expect(html).not.toContain("Signal");
    }
  });
});
