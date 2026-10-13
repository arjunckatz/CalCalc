import { createHash, randomUUID } from "node:crypto";

import {
  type AccountTurnClaim,
  type PostgresAccountConversationTurnRepository,
} from "@cal-calc/persistence";

import {
  parseIdempotencyKey,
  type IdempotencyKey,
} from "../mutations/mutation-identity.js";
import {
  acceptCalendarContext,
  type AcceptedCalendarContext,
  type RawCalendarContext,
} from "./calendar-context.js";

const namespace = "calcalc:account-turn:v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccountTurnRequest {
  readonly trustedUserId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly userMessage: string;
  readonly calendarContext?: RawCalendarContext | null;
}

export interface AccountTurnIdentity {
  readonly userId: string;
  readonly turnKey: string;
  readonly requestFingerprint: string;
  readonly userMessage: string;
  readonly calendarContext: AcceptedCalendarContext | null;
}

/** Freeze accepted request meaning before any asynchronous repository work. */
export function deriveAccountTurnIdentity(
  input: AccountTurnRequest,
): AccountTurnIdentity {
  if (
    typeof input.trustedUserId !== "string" ||
    !uuidPattern.test(input.trustedUserId)
  ) {
    throw new TypeError("Invalid trusted account user ID.");
  }
  if (
    typeof input.userMessage !== "string" ||
    input.userMessage.trim() === ""
  ) {
    throw new TypeError("Invalid account turn message.");
  }
  const userId = input.trustedUserId.toLowerCase();
  const key = parseIdempotencyKey(input.idempotencyKey);
  const calendarContext = acceptCalendarContext(input.calendarContext);
  const digest = (parts: readonly unknown[]) =>
    createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
  return {
    userId,
    turnKey: `${namespace}:${digest([namespace, "key", userId, key])}`,
    requestFingerprint: digest([
      namespace,
      "request",
      userId,
      input.userMessage,
      calendarContext,
    ]),
    userMessage: input.userMessage,
    calendarContext,
  };
}

/** A pending durable claim only; no model, routing, or tool execution. */
export async function claimAccountTurn(
  repository: Pick<PostgresAccountConversationTurnRepository, "claimPending">,
  request: AccountTurnRequest,
): Promise<AccountTurnClaim> {
  const identity = deriveAccountTurnIdentity(request);
  return repository.claimPending({ id: randomUUID(), ...identity });
}
