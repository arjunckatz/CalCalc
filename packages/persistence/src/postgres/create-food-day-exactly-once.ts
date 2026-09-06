import type {
  JsonObject,
  PersistedFoodDay,
  PersistedSemanticOperation,
} from "../types.js";
import {
  PostgresFoodDayRepository,
  type CreateFoodDayRecord,
} from "./food-day-repository.js";
import {
  PostgresSemanticOperationRepository,
  SemanticOperationStateConflictError,
} from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export interface CreateFoodDayExactlyOnceInput extends CreateFoodDayRecord {
  readonly operationId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
}

export type CreateFoodDayExactlyOnceResult =
  | {
      readonly disposition: "CREATED";
      readonly foodDay: PersistedFoodDay;
      readonly operation: PersistedSemanticOperation;
    }
  | {
      readonly disposition: "REPLAYED";
      readonly foodDay: PersistedFoodDay;
      readonly operation: PersistedSemanticOperation;
    };

export type CreateFoodDayIntegrityReason =
  "MALFORMED_OPERATION_RESULT" | "REFERENCED_FOOD_DAY_NOT_FOUND";

export class CreateFoodDayIntegrityError extends Error {
  override readonly name = "CreateFoodDayIntegrityError";

  constructor(
    readonly operationKey: string,
    readonly reason: CreateFoodDayIntegrityReason,
  ) {
    super(
      reason === "MALFORMED_OPERATION_RESULT"
        ? `Succeeded semantic operation ${operationKey} has an invalid FoodDay result.`
        : `Succeeded semantic operation ${operationKey} references no FoodDay visible to this user.`,
    );
  }
}

export async function createFoodDayExactlyOnce(
  transactionRunner: PostgresTransactionRunner,
  input: CreateFoodDayExactlyOnceInput,
): Promise<CreateFoodDayExactlyOnceResult> {
  return transactionRunner.runInTransaction(async (executor) => {
    const operationRepository = new PostgresSemanticOperationRepository(
      executor,
    );
    const foodDayRepository = new PostgresFoodDayRepository(executor);
    const claim = await operationRepository.claim({
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
    });

    if (claim.disposition === "EXISTING") {
      return replayExistingOperation(
        foodDayRepository,
        input.userId,
        claim.operation,
      );
    }

    const foodDay = await foodDayRepository.create(input);
    const result = {
      kind: "FOOD_DAY_CREATED",
      foodDayId: foodDay.foodDay.id,
    } as const satisfies JsonObject;
    const completedAt = new Date().toISOString();
    const operation = await operationRepository.markSucceeded({
      userId: input.userId,
      operationKey: input.operationKey,
      result,
      completedAt,
    });
    return { disposition: "CREATED", foodDay, operation };
  });
}

async function replayExistingOperation(
  foodDayRepository: PostgresFoodDayRepository,
  userId: string,
  operation: PersistedSemanticOperation,
): Promise<CreateFoodDayExactlyOnceResult> {
  if (operation.status !== "SUCCEEDED") {
    throw new SemanticOperationStateConflictError(
      operation.operationKey,
      operation.status,
    );
  }

  const foodDayId = parseCreatedFoodDayResult(
    operation.operationKey,
    operation.result,
  );
  const foodDay = await foodDayRepository.findById(userId, foodDayId);
  if (foodDay === null) {
    throw new CreateFoodDayIntegrityError(
      operation.operationKey,
      "REFERENCED_FOOD_DAY_NOT_FOUND",
    );
  }
  return { disposition: "REPLAYED", foodDay, operation };
}

function parseCreatedFoodDayResult(
  operationKey: string,
  result: unknown,
): string {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("kind" in result) ||
    result.kind !== "FOOD_DAY_CREATED" ||
    !("foodDayId" in result) ||
    typeof result.foodDayId !== "string" ||
    result.foodDayId.trim() === ""
  ) {
    throw new CreateFoodDayIntegrityError(
      operationKey,
      "MALFORMED_OPERATION_RESULT",
    );
  }
  return result.foodDayId;
}
