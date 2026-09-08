import type {
  FastifyReply,
  FastifyRequest,
  RouteGenericInterface,
} from "fastify";

import {
  authenticateAuthorizationHeader,
  AuthenticationError,
  type AccessTokenVerifier,
  type AuthenticatedIdentity,
} from "../auth/authorization.js";

export function authenticatedHandler<Route extends RouteGenericInterface>(
  verifier: AccessTokenVerifier,
  handler: (
    identity: AuthenticatedIdentity,
    request: FastifyRequest<Route>,
    reply: FastifyReply,
  ) => Promise<unknown>,
) {
  return async (
    request: FastifyRequest<Route>,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const identity = await authenticateAuthorizationHeader(
      verifier,
      readSingleAuthorizationHeader(request),
    );
    return handler(identity, request, reply);
  };
}

function readSingleAuthorizationHeader(
  request: Pick<FastifyRequest, "raw">,
): string | undefined {
  // Raw pairs preserve duplicate occurrences that Node's parsed headers collapse.
  const rawHeaders = request.raw.rawHeaders;
  let authorization: string | undefined;
  let occurrences = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "authorization") {
      occurrences += 1;
      if (occurrences > 1) {
        throw new AuthenticationError("MALFORMED_AUTHORIZATION");
      }
      authorization = rawHeaders[index + 1];
    }
  }
  return authorization;
}
