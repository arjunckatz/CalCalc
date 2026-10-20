import { createHash } from "node:crypto";

import {
  parseIdempotencyKey,
  type IdempotencyKey,
} from "../mutations/mutation-identity.js";

/** Disjoint from client keys, legacy turn tools and FoodDay materialization. */
export function deriveAccountTurnPlanStepKey(
  trustedUserId: string,
  turnId: string,
  ordinal: number,
): IdempotencyKey {
  if (
    typeof trustedUserId !== "string" ||
    trustedUserId.trim() === "" ||
    typeof turnId !== "string" ||
    turnId.trim() === "" ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 7
  )
    throw new TypeError("Invalid durable account turn step identity.");
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "calcalc:account-turn:plan-step",
        "v1",
        "account-turn-plan-v1",
        trustedUserId,
        turnId,
        ordinal,
      ]),
      "utf8",
    )
    .digest("hex");
  return parseIdempotencyKey(`account-plan-step-v1-${digest}`);
}
