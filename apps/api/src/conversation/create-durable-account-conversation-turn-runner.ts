import {
  materializeAccountTurnFoodDay,
  PostgresAccountConversationTurnRepository,
  PostgresAccountTurnStepResultRepository,
  PostgresBodyWeightRepository,
  PostgresConversationRepository,
  PostgresFoodDayRepository,
  PostgresFoodEntryRepository,
  type PostgresExecutor,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import type {
  DurableFoodDayTurnFinalizer,
  FoodDayTurnModel,
} from "../agent/turn/food-day-turn-types.js";
import type { FoodDayTargetResolutionModel } from "./resolve-food-day-target.js";
import type { RunAccountConversationTurnRequest } from "./run-account-conversation-turn.js";
import { runDurableAccountConversationTurn } from "./run-durable-account-conversation-turn.js";

export type DurableAccountConversationTurnRunner = (
  request: RunAccountConversationTurnRequest,
) => ReturnType<typeof runDurableAccountConversationTurn>;

export interface CreateDurableAccountConversationTurnRunnerDependencies {
  readonly postgres: PostgresExecutor;
  readonly transactionRunner: PostgresTransactionRunner;
  readonly targetModel: FoodDayTargetResolutionModel;
  readonly foodDayModel: FoodDayTurnModel & DurableFoodDayTurnFinalizer;
}

/** Construct once at host startup; every request uses the same owned adapters. */
export function createDurableAccountConversationTurnRunner(
  dependencies: CreateDurableAccountConversationTurnRunnerDependencies,
): DurableAccountConversationTurnRunner {
  const turns = new PostgresAccountConversationTurnRepository(
    dependencies.postgres,
  );
  const stepResults = new PostgresAccountTurnStepResultRepository(
    dependencies.postgres,
  );
  const conversations = new PostgresConversationRepository(
    dependencies.postgres,
  );
  const foodDays = new PostgresFoodDayRepository(dependencies.postgres);
  const foodEntries = new PostgresFoodEntryRepository(dependencies.postgres);
  const bodyWeights = new PostgresBodyWeightRepository(dependencies.postgres);

  return (request) =>
    runDurableAccountConversationTurn(
      {
        planning: {
          turns,
          routing: {
            conversations,
            days: foodDays,
            turns,
            entries: foodEntries,
          },
          model: dependencies.targetModel,
          materializeFoodDay: (input) =>
            materializeAccountTurnFoodDay(
              dependencies.transactionRunner,
              input,
            ),
          foodDays,
          foodEntries,
          foodDayModel: dependencies.foodDayModel,
        },
        execution: {
          turns,
          stepResults,
          bodyWeights,
          transactionRunner: dependencies.transactionRunner,
        },
        finalization: {
          turns,
          stepResults,
          foodDays,
          foodEntries,
          bodyWeights,
          model: dependencies.foodDayModel,
        },
        pointer: { turns, stepResults, conversations },
      },
      request,
    );
}
