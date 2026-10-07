import { randomUUID } from "node:crypto";

import type { CompletedFoodDayTurnStore } from "@cal-calc/persistence";

import type {
  FoodDayTurnInput,
  FoodDayTurnPublicResult,
} from "./food-day-turn-types.js";
import { deriveFoodDayTurnIdentity } from "./food-day-turn-identity.js";

export interface RunDurableFoodDayTurnDependencies {
  readonly completedTurns: CompletedFoodDayTurnStore;
  readonly runTurn: (
    input: FoodDayTurnInput,
  ) => Promise<FoodDayTurnPublicResult>;
}

/**
 * Replays only completed turns. Concurrent misses may both perform model work;
 * the repository's insert race selects the first durable response as authority.
 */
export async function runDurableFoodDayTurn(
  dependencies: RunDurableFoodDayTurnDependencies,
  input: FoodDayTurnInput,
): Promise<FoodDayTurnPublicResult> {
  const identity = deriveFoodDayTurnIdentity(input);
  // Keep the accepted calendar date fixed across the asynchronous lookup and
  // execution, even if a trusted in-process caller later mutates its object.
  const acceptedInput: FoodDayTurnInput =
    input.calendarContext === undefined
      ? input
      : {
          ...input,
          calendarContext: {
            currentLocalDate: input.calendarContext.currentLocalDate,
          },
        };
  const completedInput = {
    userId: identity.canonicalUserId,
    foodDayId: identity.canonicalFoodDayId,
    turnKey: identity.turnKey,
    requestFingerprint: identity.requestFingerprint,
  };
  const existing =
    await dependencies.completedTurns.findCompleted(completedInput);
  if (existing !== null) return { response: existing.response };

  const result = await dependencies.runTurn(acceptedInput);
  const saved = await dependencies.completedTurns.saveCompleted({
    id: randomUUID(),
    ...completedInput,
    userMessage: acceptedInput.userMessage,
    response: result.response,
  });
  return { response: saved.turn.response };
}
