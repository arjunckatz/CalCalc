import { isDeepStrictEqual } from "node:util";

import {
  FoodDayNotFoundError,
  type PostgresAccountConversationTurnRepository,
  type PostgresFoodEntryRepository,
} from "@cal-calc/persistence";

import type { ListFoodEntriesForFoodDayDependencies } from "../queries/list-food-entries-for-food-day.js";
import { getFoodDayState } from "../state/get-food-day-state.js";
import type { FoodDayState } from "../state/build-food-day-state.js";
import type { AccountConversationTurnResult } from "./run-account-conversation-turn.js";

type FoodDayReady = Extract<
  AccountConversationTurnResult,
  { kind: "FOOD_DAY_READY" }
>;

export interface PrepareAccountTurnFoodDayExecutionDependencies extends ListFoodEntriesForFoodDayDependencies {
  readonly turns: Pick<
    PostgresAccountConversationTurnRepository,
    "findExecutionCheckpoint"
  >;
  readonly foodEntries: Pick<
    PostgresFoodEntryRepository,
    "findById" | "listActiveByFoodDay"
  >;
}

export type PrepareAccountTurnFoodDayExecutionResult =
  | {
      readonly kind: "EXECUTION_CONTEXT_READY";
      readonly turnId: string;
      readonly foodDayId: string;
      readonly routingKind: "DATE_TARGET" | "EXISTING_DAY";
      readonly state: FoodDayState;
    }
  | {
      readonly kind: "EXECUTION_CONTEXT_READY";
      readonly turnId: string;
      readonly foodDayId: string;
      readonly routingKind: "EXISTING_ENTRY_REFERENCE";
      readonly state: FoodDayState;
      readonly entryReference: {
        readonly entryId: string;
        readonly expectedRevision: number;
      };
    }
  | {
      readonly kind: "ENTRY_REFERENCE_STALE";
      readonly turnId: string;
      readonly foodDayId: string;
      readonly entryId: string;
      readonly expectedRevision: number;
    };

export class AccountTurnExecutionTargetIntegrityError extends Error {
  override readonly name = "AccountTurnExecutionTargetIntegrityError";
  constructor() {
    super("Account turn execution target is inconsistent.");
  }
}

export class AccountTurnExecutionTargetIneligibleError extends Error {
  override readonly name = "AccountTurnExecutionTargetIneligibleError";
  constructor() {
    super("Account turn is not pending execution preparation.");
  }
}

/** Read-only execution snapshot after M5A7B. M5A7A has already acquired any
 * DATE_TARGET FoodDay; this boundary neither reacquires it nor freezes it for
 * a future model call. Later mutations must still use canonical CAS guards. */
export async function prepareAccountTurnFoodDayExecution(
  dependencies: PrepareAccountTurnFoodDayExecutionDependencies,
  input: {
    readonly trustedUserId: string;
    readonly ready: FoodDayReady;
  },
): Promise<PrepareAccountTurnFoodDayExecutionResult> {
  const { trustedUserId, ready } = input;
  if (ready.kind !== "FOOD_DAY_READY")
    throw new AccountTurnExecutionTargetIneligibleError();
  let checkpoint: Awaited<
    ReturnType<
      PrepareAccountTurnFoodDayExecutionDependencies["turns"]["findExecutionCheckpoint"]
    >
  >;
  try {
    checkpoint = await dependencies.turns.findExecutionCheckpoint(
      trustedUserId,
      ready.turnId,
    );
  } catch (error) {
    if (error instanceof TypeError)
      throw new AccountTurnExecutionTargetIntegrityError();
    throw error;
  }
  if (
    checkpoint === null ||
    checkpoint.turnId !== ready.turnId ||
    checkpoint.userId !== trustedUserId
  )
    throw new AccountTurnExecutionTargetIntegrityError();
  if (checkpoint.status !== "PENDING")
    throw new AccountTurnExecutionTargetIneligibleError();
  if (!isDeepStrictEqual(checkpoint.routingResolution, ready.resolution))
    throw new AccountTurnExecutionTargetIntegrityError();
  if (ready.resolution.kind === "DATE_TARGET") {
    if (
      ready.source === "RESOLVED_EXISTING" ||
      checkpoint.materializedFoodDayId !== ready.foodDayId ||
      checkpoint.resolvedFoodDayId !== null
    )
      throw new AccountTurnExecutionTargetIntegrityError();
  } else if (
    ready.source !== "RESOLVED_EXISTING" ||
    ready.resolution.foodDayId !== ready.foodDayId ||
    checkpoint.resolvedFoodDayId !== ready.foodDayId ||
    checkpoint.materializedFoodDayId !== null
  ) {
    throw new AccountTurnExecutionTargetIntegrityError();
  }

  let state: FoodDayState;
  try {
    state = await getFoodDayState(dependencies, {
      trustedUserId,
      foodDayId: ready.foodDayId,
    });
  } catch (error) {
    if (error instanceof FoodDayNotFoundError)
      throw new AccountTurnExecutionTargetIntegrityError();
    throw error;
  }
  if (state.foodDay.id !== ready.foodDayId)
    throw new AccountTurnExecutionTargetIntegrityError();

  if (ready.resolution.kind !== "EXISTING_ENTRY_REFERENCE") {
    return {
      kind: "EXECUTION_CONTEXT_READY",
      turnId: ready.turnId,
      foodDayId: ready.foodDayId,
      routingKind: ready.resolution.kind,
      state,
    };
  }
  const { entryId, revision: expectedRevision } = ready.resolution;
  const stale = {
    kind: "ENTRY_REFERENCE_STALE",
    turnId: ready.turnId,
    foodDayId: ready.foodDayId,
    entryId,
    expectedRevision,
  } as const;
  const found = await dependencies.foodEntries.findById(trustedUserId, entryId);
  if (found === null) return stale;
  if (
    found.userId !== trustedUserId ||
    found.entry.id !== entryId ||
    found.entry.foodDayId !== ready.foodDayId
  )
    throw new AccountTurnExecutionTargetIntegrityError();
  if (
    found.entry.deletedAt !== undefined ||
    found.entry.revision !== expectedRevision
  )
    return stale;
  const stateEntry = state.entries.find((entry) => entry.id === entryId);
  if (stateEntry === undefined || stateEntry.revision !== expectedRevision)
    return stale;
  return {
    kind: "EXECUTION_CONTEXT_READY",
    turnId: ready.turnId,
    foodDayId: ready.foodDayId,
    routingKind: ready.resolution.kind,
    state,
    entryReference: { entryId, expectedRevision },
  };
}
