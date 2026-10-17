import { createHash, randomUUID } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";

import { parseAccountTurnRoutingResolution } from "../account-turn-values.js";
import type { JsonObject } from "../types.js";
import { PostgresAccountNutritionTargetsRepository } from "./account-nutrition-targets-repository.js";
import { PostgresFoodDayRepository } from "./food-day-repository.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import { PostgresSemanticOperationRepository } from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

const namespace = "calcalc:account-turn:materialize-food-day:v1";
const resultSchema = "account-turn-materialization-v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MaterializeAccountTurnFoodDayResult =
  | {
      readonly kind: "FOOD_DAY_READY";
      readonly foodDayId: string;
      readonly source: "CREATED" | "EXISTING";
    }
  | { readonly kind: "TARGETS_REQUIRED" }
  | { readonly kind: "AMBIGUOUS_EXISTING_DAYS" };

export class AccountTurnMaterializationIneligibleError extends Error {
  override readonly name = "AccountTurnMaterializationIneligibleError";
  constructor(
    readonly reason:
      | "TURN_NOT_FOUND"
      | "TURN_COMPLETED"
      | "ROUTING_NOT_DATE_TARGET"
      | "EXECUTION_PLAN_EXISTS",
  ) {
    super("Account turn is not eligible for FoodDay materialization.");
  }
}

export class AccountTurnMaterializationIntegrityError extends Error {
  override readonly name = "AccountTurnMaterializationIntegrityError";
  constructor() {
    super("Account turn materialization state is inconsistent.");
  }
}

/** One short transaction. Lock order: conversation -> turn -> up to two
 * candidate FoodDays (shared) -> account target (shared, only when creating)
 * -> semantic operation -> FoodDay insert/link. Only automatic materialization
 * is serialized by the conversation mutex. No model or tool execution occurs. */
export async function materializeAccountTurnFoodDay(
  transactionRunner: PostgresTransactionRunner,
  input: { readonly trustedUserId: string; readonly turnId: string },
): Promise<MaterializeAccountTurnFoodDayResult> {
  if (!uuidPattern.test(input.turnId) || !uuidPattern.test(input.trustedUserId))
    throw new AccountTurnMaterializationIneligibleError("TURN_NOT_FOUND");
  const turnId = input.turnId.toLowerCase();
  const userId = input.trustedUserId.toLowerCase();
  return transactionRunner.runInTransaction(async (executor) => {
    const conversation = await executor.query(
      `select user_id from public.conversations
       where user_id = $1 for update`,
      [userId],
    );
    if (conversation.rows[0] === undefined)
      throw new AccountTurnMaterializationIneligibleError("TURN_NOT_FOUND");

    const turn = await loadLockedTurn(executor, userId, turnId);
    if (turn.status === "COMPLETED")
      throw new AccountTurnMaterializationIneligibleError("TURN_COMPLETED");
    if (turn.routingResolution.kind !== "DATE_TARGET")
      throw new AccountTurnMaterializationIneligibleError(
        "ROUTING_NOT_DATE_TARGET",
      );
    if (turn.resolvedFoodDayId !== null)
      throw new AccountTurnMaterializationIntegrityError();
    const localDate = turn.routingResolution.localDate;
    const operationKey = `${namespace}:${turn.id}`;
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify([namespace, userId, turn.id, localDate]))
      .digest("hex");
    const operations = new PostgresSemanticOperationRepository(executor);
    const foodDays = new PostgresFoodDayRepository(executor);

    if (turn.materializedFoodDayId !== null) {
      const operation = await operations.findByKey(userId, operationKey);
      if (
        operation === null ||
        operation.userId !== userId ||
        operation.requestFingerprint !== requestFingerprint ||
        operation.status !== "SUCCEEDED"
      )
        throw new AccountTurnMaterializationIntegrityError();
      const result = parseOperationResult(operation.result, {
        turnId: turn.id,
        localDate,
        foodDayId: turn.materializedFoodDayId,
      });
      if ((await foodDays.findById(userId, result.foodDayId)) === null)
        throw new AccountTurnMaterializationIntegrityError();
      return result;
    }

    if (turn.executionPlan !== null)
      throw new AccountTurnMaterializationIneligibleError(
        "EXECUTION_PLAN_EXISTS",
      );
    const candidates = await foodDays.findUpToTwoByLocalDate(userId, localDate);
    if (candidates.length > 1) return { kind: "AMBIGUOUS_EXISTING_DAYS" };

    let source: "CREATED" | "EXISTING";
    let foodDayId: string;
    let targets: Awaited<
      ReturnType<PostgresAccountNutritionTargetsRepository["findByUser"]>
    > = null;
    if (candidates.length === 1) {
      source = "EXISTING";
      foodDayId = candidates[0]!.foodDay.id;
    } else {
      targets = await new PostgresAccountNutritionTargetsRepository(
        executor,
      ).findByUserForShare(userId);
      if (targets === null) return { kind: "TARGETS_REQUIRED" };
      source = "CREATED";
      foodDayId = randomUUID();
    }

    const claim = await operations.claim({
      id: randomUUID(),
      userId,
      operationKey,
      requestFingerprint,
    });
    // A succeeded claim without the turn link is impossible after an atomic commit.
    if (claim.disposition !== "CREATED")
      throw new AccountTurnMaterializationIntegrityError();

    if (targets !== null) {
      await foodDays.create({
        userId,
        foodDay: createFoodDay({
          id: foodDayId,
          status: "OPEN",
          calorieTarget: targets.calorieTarget,
          proteinTarget: targets.proteinTarget,
        }),
        completeness: "UNKNOWN",
        localDate,
      });
    }
    const result = {
      schema: resultSchema,
      kind: "FOOD_DAY_READY",
      turnId: turn.id,
      localDate,
      foodDayId,
      source,
    } as const satisfies JsonObject;
    await operations.markSucceeded({
      userId,
      operationKey,
      result,
    });
    const bound = await executor.query(
      `update public.conversation_turns
       set materialized_food_day_id = $3
       where id = $1 and user_id = $2 and status = 'PENDING'
         and materialized_food_day_id is null
         and routing_resolution ->> 'kind' = 'DATE_TARGET'
         and execution_plan is null
       returning id`,
      [turn.id, userId, foodDayId],
    );
    if (bound.rows.length !== 1)
      throw new AccountTurnMaterializationIntegrityError();
    return { kind: "FOOD_DAY_READY", foodDayId, source };
  });
}

interface LockedTurn {
  readonly id: string;
  readonly status: "PENDING" | "COMPLETED";
  readonly routingResolution: ReturnType<
    typeof parseAccountTurnRoutingResolution
  >;
  readonly resolvedFoodDayId: string | null;
  readonly materializedFoodDayId: string | null;
  readonly executionPlan: unknown;
}

async function loadLockedTurn(
  executor: PostgresExecutor,
  userId: string,
  turnId: string,
): Promise<LockedTurn> {
  const result = await executor.query(
    `select id, status, routing_resolution, resolved_food_day_id,
            materialized_food_day_id, execution_plan
     from public.conversation_turns
     where id = $1 and user_id = $2 for update`,
    [turnId, userId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new AccountTurnMaterializationIneligibleError("TURN_NOT_FOUND");
  if (
    !isRecord(row) ||
    row.id !== turnId ||
    (row.status !== "PENDING" && row.status !== "COMPLETED") ||
    (row.resolved_food_day_id !== null &&
      !validUuid(row.resolved_food_day_id)) ||
    (row.materialized_food_day_id !== null &&
      !validUuid(row.materialized_food_day_id)) ||
    row.execution_plan === undefined
  )
    throw new AccountTurnMaterializationIntegrityError();
  if (row.routing_resolution === null)
    throw new AccountTurnMaterializationIneligibleError(
      "ROUTING_NOT_DATE_TARGET",
    );
  let routingResolution: LockedTurn["routingResolution"];
  try {
    routingResolution = parseAccountTurnRoutingResolution(
      row.routing_resolution,
    );
  } catch {
    throw new AccountTurnMaterializationIntegrityError();
  }
  return {
    id: row.id,
    status: row.status,
    routingResolution,
    resolvedFoodDayId: row.resolved_food_day_id as string | null,
    materializedFoodDayId: row.materialized_food_day_id as string | null,
    executionPlan: row.execution_plan,
  };
}

function parseOperationResult(
  value: unknown,
  expected: {
    readonly turnId: string;
    readonly localDate: string;
    readonly foodDayId: string;
  },
): Extract<MaterializeAccountTurnFoodDayResult, { kind: "FOOD_DAY_READY" }> {
  if (
    !isRecord(value) ||
    Reflect.ownKeys(value).length !== 6 ||
    value.schema !== resultSchema ||
    value.kind !== "FOOD_DAY_READY" ||
    value.turnId !== expected.turnId ||
    value.localDate !== expected.localDate ||
    value.foodDayId !== expected.foodDayId ||
    !validUuid(value.foodDayId) ||
    (value.source !== "CREATED" && value.source !== "EXISTING")
  )
    throw new AccountTurnMaterializationIntegrityError();
  return {
    kind: "FOOD_DAY_READY",
    foodDayId: value.foodDayId,
    source: value.source,
  };
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
