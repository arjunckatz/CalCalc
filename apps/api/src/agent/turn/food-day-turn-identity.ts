import { createHash } from "node:crypto";

import {
  parseIdempotencyKey,
  type IdempotencyKey,
} from "../../mutations/mutation-identity.js";

export interface FoodDayTurnIdentityInput {
  readonly trustedUserId: string;
  readonly foodDayId: string;
  readonly turnIdempotencyKey: IdempotencyKey;
  readonly userMessage: string;
}

export interface FoodDayTurnIdentity {
  readonly canonicalUserId: string;
  readonly canonicalFoodDayId: string;
  readonly turnKey: string;
  readonly requestFingerprint: string;
}

type FoodDayTurnIdentityErrorReason =
  "INVALID_TRUSTED_USER_ID" | "INVALID_FOOD_DAY_ID" | "INVALID_USER_MESSAGE";

export class FoodDayTurnIdentityError extends Error {
  override readonly name = "FoodDayTurnIdentityError";

  constructor(readonly reason: FoodDayTurnIdentityErrorReason) {
    super("Invalid trusted FoodDay turn identity input.");
  }
}

const namespace = "calcalc:food-day-turn";
const version = "v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deriveFoodDayTurnIdentity(
  input: FoodDayTurnIdentityInput,
): FoodDayTurnIdentity {
  const canonicalUserId = canonicalUuid(
    input.trustedUserId,
    "INVALID_TRUSTED_USER_ID",
  );
  const canonicalFoodDayId = canonicalUuid(
    input.foodDayId,
    "INVALID_FOOD_DAY_ID",
  );
  const turnIdempotencyKey = parseIdempotencyKey(input.turnIdempotencyKey);
  if (
    typeof input.userMessage !== "string" ||
    input.userMessage.trim() === ""
  ) {
    throw new FoodDayTurnIdentityError("INVALID_USER_MESSAGE");
  }

  const turnHash = sha256(
    JSON.stringify([
      `${namespace}:key`,
      version,
      canonicalUserId,
      canonicalFoodDayId,
      turnIdempotencyKey,
    ]),
  );
  const requestFingerprint = sha256(
    JSON.stringify([
      `${namespace}:request`,
      version,
      canonicalUserId,
      canonicalFoodDayId,
      input.userMessage,
    ]),
  );
  return {
    canonicalUserId,
    canonicalFoodDayId,
    turnKey: `${namespace}:${version}:${turnHash}`,
    requestFingerprint,
  };
}

function canonicalUuid(
  value: unknown,
  reason: Extract<
    FoodDayTurnIdentityErrorReason,
    "INVALID_TRUSTED_USER_ID" | "INVALID_FOOD_DAY_ID"
  >,
): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new FoodDayTurnIdentityError(reason);
  }
  return value.toLowerCase();
}

function sha256(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}
