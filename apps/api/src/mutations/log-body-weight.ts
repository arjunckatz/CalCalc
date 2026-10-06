import { randomUUID } from "node:crypto";

import { createBodyWeightEntry, type BodyWeightUnit } from "@cal-calc/domain";
import {
  createBodyWeightExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import {
  deriveMutationIdentity,
  type IdempotencyKey,
} from "./mutation-identity.js";

export interface LogBodyWeightCommand {
  readonly localDate: string;
  readonly sourceValue: string;
  readonly sourceUnit: BodyWeightUnit;
}

export interface LogBodyWeightMutationInput {
  /** Verified application identity, never supplied by the command. */
  readonly trustedUserId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly command: LogBodyWeightCommand;
}

export interface LogBodyWeightMutationResult {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly weightEntry: {
    readonly id: string;
    readonly localDate: string;
    readonly sourceValue: string;
    readonly sourceUnit: BodyWeightUnit;
    readonly weightKg: string;
    readonly createdAt: string;
  };
}

export async function logBodyWeightMutation(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  input: LogBodyWeightMutationInput,
): Promise<LogBodyWeightMutationResult> {
  const command = input.command;
  if (
    command === null ||
    typeof command !== "object" ||
    Array.isArray(command) ||
    Reflect.ownKeys(command).length !== 3 ||
    Reflect.ownKeys(command).some(
      (key) =>
        typeof key !== "string" ||
        !["localDate", "sourceValue", "sourceUnit"].includes(key) ||
        !Object.getOwnPropertyDescriptor(command, key)?.enumerable ||
        !("value" in Object.getOwnPropertyDescriptor(command, key)!),
    )
  ) {
    throw new InvalidLogBodyWeightCommandError();
  }
  const entry = createBodyWeightEntry({
    id: randomUUID(),
    localDate: command.localDate,
    sourceValue: command.sourceValue,
    sourceUnit: command.sourceUnit,
  });
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "LOG_BODY_WEIGHT",
    idempotencyKey: input.idempotencyKey,
    semanticPayload: {
      localDate: entry.localDate,
      sourceValue: entry.sourceValue,
      sourceUnit: entry.sourceUnit,
    },
  });
  const result = await createBodyWeightExactlyOnce(
    dependencies.transactionRunner,
    {
      userId: input.trustedUserId,
      operationId: randomUUID(),
      ...identity,
      entry,
    },
  );
  return {
    disposition: result.disposition,
    weightEntry: {
      id: result.weightEntry.entry.id,
      localDate: result.weightEntry.entry.localDate,
      sourceValue: result.weightEntry.entry.sourceValue,
      sourceUnit: result.weightEntry.entry.sourceUnit,
      weightKg: result.weightEntry.entry.weightKg,
      createdAt: result.weightEntry.createdAt,
    },
  };
}

export class InvalidLogBodyWeightCommandError extends Error {
  override readonly name = "InvalidLogBodyWeightCommandError";
  constructor() {
    super("Invalid body-weight logging command.");
  }
}
