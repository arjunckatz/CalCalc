import { createHash } from "node:crypto";

import {
  parseIdempotencyKey,
  type IdempotencyKey,
} from "../../mutations/mutation-identity.js";

/**
 * Address a tool slot within a trusted turn. Model arguments are deliberately
 * excluded: a changed command or action at this slot must reach the
 * agent-scoped semantic-fingerprint conflict check rather than acquire a new
 * operation key.
 */
export function deriveFoodDayToolIdempotencyKey(
  turnIdempotencyKey: IdempotencyKey,
  toolIndex: number,
): IdempotencyKey {
  const trustedTurnKey = parseIdempotencyKey(turnIdempotencyKey);
  if (!Number.isSafeInteger(toolIndex) || toolIndex < 0) {
    throw new RangeError("Tool index must be a non-negative safe integer.");
  }

  const material = JSON.stringify([
    "calcalc:turn-tool-idempotency",
    "v1",
    trustedTurnKey,
    toolIndex,
  ]);
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return parseIdempotencyKey(`turn-tool-v1-${digest}`);
}
