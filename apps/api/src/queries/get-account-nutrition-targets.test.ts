import { createFoodDay } from "@cal-calc/domain";
import { describe, expect, it, vi } from "vitest";

import { getAccountNutritionTargets } from "./get-account-nutrition-targets.js";

const userId = "10000000-0000-4000-8000-000000000001";

describe("getAccountNutritionTargets", () => {
  it("does not invent defaults or inherit a FoodDay when no row exists", async () => {
    const findByUser = vi.fn().mockResolvedValue(null);
    expect(
      await getAccountNutritionTargets(
        { targets: { findByUser } },
        { trustedUserId: userId },
      ),
    ).toEqual({ kind: "NOT_CONFIGURED" });
    expect(findByUser).toHaveBeenCalledExactlyOnceWith(userId);
  });

  it("returns the canonical owner-scoped target snapshot unchanged", async () => {
    const targets = {
      userId,
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
      version: 0,
      createdAt: "2026-10-17T00:00:00Z",
      updatedAt: "2026-10-17T00:00:00Z",
    };
    const findByUser = vi.fn().mockResolvedValue(targets);
    expect(
      await getAccountNutritionTargets(
        { targets: { findByUser } },
        { trustedUserId: userId },
      ),
    ).toEqual({ kind: "CONFIGURED", targets });
    expect(findByUser).toHaveBeenCalledExactlyOnceWith(userId);
  });

  it("passes retrieved target strings into FoodDay creation without a numeric translation", async () => {
    const targets = {
      userId,
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
      version: 0,
      createdAt: "2026-10-17T00:00:00Z",
      updatedAt: "2026-10-17T00:00:00Z",
    };
    const result = await getAccountNutritionTargets(
      { targets: { findByUser: vi.fn().mockResolvedValue(targets) } },
      { trustedUserId: userId },
    );
    expect(result.kind).toBe("CONFIGURED");
    if (result.kind !== "CONFIGURED") throw new Error("Targets absent.");
    const futureFoodDayInput: Parameters<typeof createFoodDay>[0] = {
      id: "snapshot-compatibility-only",
      status: "OPEN",
      calorieTarget: result.targets.calorieTarget,
      proteinTarget: result.targets.proteinTarget,
    };
    expect(futureFoodDayInput.calorieTarget).toBe(targets.calorieTarget);
    expect(futureFoodDayInput.proteinTarget).toBe(targets.proteinTarget);
    expect(typeof futureFoodDayInput.calorieTarget).toBe("string");
  });
});
