import type { FastifyRequest } from "fastify";

import {
  MutationIdentityError,
  parseIdempotencyKey,
  type IdempotencyKey,
} from "../mutations/mutation-identity.js";

export function readIdempotencyKey(
  request: Pick<FastifyRequest, "raw">,
): IdempotencyKey {
  const headers = request.raw.rawHeaders;
  let count = 0;
  let value: string | undefined;
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === "idempotency-key") {
      count += 1;
      value = headers[index + 1];
    }
  }
  if (count !== 1) throw new MutationIdentityError("INVALID_IDEMPOTENCY_KEY");
  return parseIdempotencyKey(value);
}
