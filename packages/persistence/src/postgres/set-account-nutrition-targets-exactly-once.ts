import { normalizeDecimal } from "@cal-calc/domain";

import type {
  AccountNutritionTargets,
  JsonObject,
  PersistedSemanticOperation,
} from "../types.js";
import {
  PostgresAccountNutritionTargetsRepository,
  type SetAccountNutritionTargetsRecord,
} from "./account-nutrition-targets-repository.js";
import {
  PostgresSemanticOperationRepository,
  SemanticOperationStateConflictError,
} from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export interface SetAccountNutritionTargetsExactlyOnceInput extends SetAccountNutritionTargetsRecord {
  readonly operationId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
}

export interface SetAccountNutritionTargetsExactlyOnceResult {
  readonly disposition: "APPLIED" | "REPLAYED";
  /** The result of this operation, not a later configuration value. */
  readonly targets: AccountNutritionTargets;
  readonly operation: PersistedSemanticOperation;
}

export class SetAccountNutritionTargetsIntegrityError extends Error {
  override readonly name = "SetAccountNutritionTargetsIntegrityError";

  constructor() {
    super(
      "Succeeded account target operation has an invalid persisted result.",
    );
  }
}

export async function setAccountNutritionTargetsExactlyOnce(
  transactionRunner: PostgresTransactionRunner,
  input: SetAccountNutritionTargetsExactlyOnceInput,
): Promise<SetAccountNutritionTargetsExactlyOnceResult> {
  return transactionRunner.runInTransaction(async (executor) => {
    const operations = new PostgresSemanticOperationRepository(executor);
    const targets = new PostgresAccountNutritionTargetsRepository(executor);
    const claim = await operations.claim({
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
    });
    if (claim.disposition === "EXISTING") {
      if (claim.operation.status !== "SUCCEEDED")
        throw new SemanticOperationStateConflictError(
          claim.operation.operationKey,
          claim.operation.status,
        );
      return {
        disposition: "REPLAYED",
        targets: parseResult(input.userId, claim.operation.result),
        operation: claim.operation,
      };
    }

    const updated = await targets.setWithExpectedVersion(input);
    const result = {
      kind: "ACCOUNT_NUTRITION_TARGETS_SET",
      calorieTarget: updated.calorieTarget,
      proteinTarget: updated.proteinTarget,
      version: updated.version,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    } as const satisfies JsonObject;
    const operation = await operations.markSucceeded({
      userId: input.userId,
      operationKey: input.operationKey,
      result,
    });
    return { disposition: "APPLIED", targets: updated, operation };
  });
}

function parseResult(userId: string, value: unknown): AccountNutritionTargets {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 6 ||
    !("kind" in value) ||
    value.kind !== "ACCOUNT_NUTRITION_TARGETS_SET" ||
    !("calorieTarget" in value) ||
    typeof value.calorieTarget !== "string" ||
    !("proteinTarget" in value) ||
    typeof value.proteinTarget !== "string" ||
    !("version" in value) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string"
  ) {
    throw new SetAccountNutritionTargetsIntegrityError();
  }
  try {
    const calorieTarget = normalizeDecimal(value.calorieTarget);
    const proteinTarget = normalizeDecimal(value.proteinTarget);
    if (
      calorieTarget !== value.calorieTarget ||
      proteinTarget !== value.proteinTarget
    )
      throw new SetAccountNutritionTargetsIntegrityError();
    return {
      userId,
      calorieTarget,
      proteinTarget,
      version: value.version as number,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  } catch {
    throw new SetAccountNutritionTargetsIntegrityError();
  }
}
