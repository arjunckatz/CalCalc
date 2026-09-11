import { createHash } from "node:crypto";

export type MutationAction = "CREATE_FOOD_DAY" | "CREATE_FOOD_ENTRY";

export type SemanticValue =
  | null
  | boolean
  | string
  | number
  | readonly SemanticValue[]
  | { readonly [key: string]: SemanticValue };

declare const idempotencyKeyBrand: unique symbol;
export type IdempotencyKey = string & {
  readonly [idempotencyKeyBrand]: true;
};

export interface MutationIdentityInput {
  /** Application code must supply the verified identity.userId, never body data. */
  readonly trustedUserId: string;
  /** Chosen by application code, not by an external request or tool caller. */
  readonly action: MutationAction;
  readonly idempotencyKey: IdempotencyKey;
  /** Already validated command meaning; exclude transport/generated metadata. */
  readonly semanticPayload: SemanticValue;
}

export interface MutationIdentity {
  readonly operationKey: string;
  readonly requestFingerprint: string;
}

const messages = {
  INVALID_IDEMPOTENCY_KEY: "Invalid idempotency key.",
  INVALID_TRUSTED_USER_ID: "Invalid trusted user identity.",
  INVALID_ACTION: "Unsupported mutation action.",
  INVALID_SEMANTIC_PAYLOAD: "Invalid semantic command representation.",
} as const;

export class MutationIdentityError extends Error {
  override readonly name = "MutationIdentityError";

  constructor(readonly reason: keyof typeof messages) {
    super(messages[reason]);
  }
}

const version = "v1";

export function parseIdempotencyKey(value: unknown): IdempotencyKey {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    /[^A-Za-z0-9._~-]/.test(value)
  ) {
    throw new MutationIdentityError("INVALID_IDEMPOTENCY_KEY");
  }
  return value as IdempotencyKey;
}

/** Pure derivation, not authentication or action-specific command validation. */
export function deriveMutationIdentity(
  input: MutationIdentityInput,
): MutationIdentity {
  const { trustedUserId, action } = input;
  if (typeof trustedUserId !== "string" || trustedUserId.trim() === "") {
    throw new MutationIdentityError("INVALID_TRUSTED_USER_ID");
  }
  if (action !== "CREATE_FOOD_DAY" && action !== "CREATE_FOOD_ENTRY") {
    throw new MutationIdentityError("INVALID_ACTION");
  }
  // Revalidate at runtime even if a caller bypasses the branded TypeScript type.
  const retryKey = parseIdempotencyKey(input.idempotencyKey);
  let semanticCommand: string;
  try {
    semanticCommand = canonicalize(input.semanticPayload, new Set());
  } catch {
    // Never retain payload values or errors from object inspection as a cause.
    throw new MutationIdentityError("INVALID_SEMANTIC_PAYLOAD");
  }
  const operationHash = sha256(
    JSON.stringify([
      "calcalc:operation-key",
      version,
      action,
      trustedUserId,
      retryKey,
    ]),
  );
  const requestFingerprint = sha256(
    JSON.stringify([
      "calcalc:request-fingerprint",
      version,
      action,
      trustedUserId,
      semanticCommand,
    ]),
  );
  return {
    operationKey: `calcalc:${version}:${action}:${operationHash}`,
    requestFingerprint,
  };
}

function sha256(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new MutationIdentityError("INVALID_SEMANTIC_PAYLOAD");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    throw new MutationIdentityError("INVALID_SEMANTIC_PAYLOAD");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new MutationIdentityError("INVALID_SEMANTIC_PAYLOAD");
  }
  ancestors.add(value);
  try {
    if (array) {
      if (keys.length !== value.length + 1) {
        throw new MutationIdentityError("INVALID_SEMANTIC_PAYLOAD");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(canonicalize(dataProperty(value, String(index)), ancestors));
      }
      return `[${items.join(",")}]`;
    }
    return `{${(keys as string[])
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(dataProperty(value, key), ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    throw new MutationIdentityError("INVALID_SEMANTIC_PAYLOAD");
  }
  return descriptor.value;
}
