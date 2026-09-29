import {
  PostgresFoodDayRepository,
  PostgresFoodDayTurnResultRepository,
  PostgresFoodEntryRepository,
  type PostgresExecutor,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import type {
  FoodDayTurnInput,
  FoodDayTurnModel,
  FoodDayTurnPublicResult,
} from "./food-day-turn-types.js";
import { runDurableFoodDayTurn } from "./run-durable-food-day-turn.js";
import { runFoodDayTurn } from "./run-food-day-turn.js";

export const RECENT_FOOD_DAY_TRANSCRIPT_LIMIT = 8;

export type FoodDayTurnRunner = (
  input: FoodDayTurnInput,
) => Promise<FoodDayTurnPublicResult>;

export interface CreateFoodDayTurnRunnerDependencies {
  readonly postgres: PostgresExecutor;
  readonly transactionRunner: PostgresTransactionRunner;
  readonly model: FoodDayTurnModel;
}

/** Compose the provider-neutral turn runner with production persistence adapters. */
export function createFoodDayTurnRunner(
  dependencies: CreateFoodDayTurnRunnerDependencies,
): FoodDayTurnRunner {
  const foodDays = new PostgresFoodDayRepository(dependencies.postgres);
  const foodEntries = new PostgresFoodEntryRepository(dependencies.postgres);
  const completedTurns = new PostgresFoodDayTurnResultRepository(
    dependencies.postgres,
  );
  return (input) =>
    runDurableFoodDayTurn(
      {
        completedTurns,
        runTurn: (turnInput) =>
          runFoodDayTurn(
            {
              foodDays,
              foodEntries,
              transactionRunner: dependencies.transactionRunner,
              model: dependencies.model,
              loadRecentTranscript: async ({ trustedUserId, foodDayId }) =>
                completedTurns.listRecentCompletedForFoodDay({
                  userId: trustedUserId,
                  foodDayId,
                  limit: RECENT_FOOD_DAY_TRANSCRIPT_LIMIT,
                }),
            },
            turnInput,
          ),
      },
      input,
    );
}
