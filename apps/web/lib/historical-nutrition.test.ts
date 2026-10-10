import { describe,expect,it } from "vitest";
import { calculateDailyProgress,calculateTrendSummary,calculateTogetherMemberProgress } from "./dashboard";

describe("historical nutrition display calculations",()=>{
  it("does not report unknown protein as zero or a complete remaining target",()=>{
    const result=calculateDailyProgress({caloriesBest:1000,caloriesLow:800,caloriesHigh:1200,proteinG:null,carbsG:null,fatG:null},{calorieTarget:2200,proteinTargetG:160});
    expect(result.calorieHint).toBe("1200 kcal remaining");expect(result.proteinHint).toContain("unknown");
    const shared=calculateTogetherMemberProgress(2200,1000,160,null,[{day:"2026-09-12",calories:1000,proteinG:null}]);
    expect(shared.proteinConsumed).toBeNull();expect(shared.proteinHint).toContain("unknown");expect(shared.trendSummary.avgProteinG).toBeNull();
  });
  it("keeps incomplete day averages unknown rather than averaging a zero-filled day",()=>{
    const summary=calculateTrendSummary([{day:"2026-09-11",caloriesBest:1000,proteinG:50},{day:"2026-09-12",caloriesBest:null,proteinG:null}],7,{calorieTarget:2200,proteinTargetG:160});
    expect(summary.calorieAverage).toBeNull();expect(summary.proteinAverage).toBeNull();expect(summary.calorieHint).toContain("incomplete");
  });
});
