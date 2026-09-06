import {
  FoodDayNotFoundError,
  type PostgresFoodDayRepository,
} from "./postgres/food-day-repository.js";
import type { PersistedFoodDay } from "./types.js";

export interface ResolveFoodDayTargetInput {
  readonly userId: string;
  readonly foodDayId?: string;
}

export type ResolveFoodDayTargetResult =
  | {
      readonly disposition: "RESOLVED";
      readonly reason: "EXPLICIT" | "SOLE_NON_CLOSED";
      readonly foodDay: PersistedFoodDay;
    }
  | { readonly disposition: "NONE" }
  | {
      readonly disposition: "AMBIGUOUS";
      readonly candidates: readonly PersistedFoodDay[];
    };

export async function resolveFoodDayTarget(
  repository: Pick<PostgresFoodDayRepository, "findById" | "findNonClosed">,
  input: ResolveFoodDayTargetInput,
): Promise<ResolveFoodDayTargetResult> {
  if (input.foodDayId !== undefined) {
    const foodDay = await repository.findById(input.userId, input.foodDayId);
    if (foodDay === null) throw new FoodDayNotFoundError(input.foodDayId);
    return { disposition: "RESOLVED", reason: "EXPLICIT", foodDay };
  }

  const candidates = await repository.findNonClosed(input.userId);
  const soleCandidate = candidates[0];
  if (soleCandidate === undefined) return { disposition: "NONE" };
  if (candidates.length === 1) {
    return {
      disposition: "RESOLVED",
      reason: "SOLE_NON_CLOSED",
      foodDay: soleCandidate,
    };
  }
  return { disposition: "AMBIGUOUS", candidates };
}
