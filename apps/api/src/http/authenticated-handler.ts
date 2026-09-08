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
    const authorization = request.headers.authorization;
    delete request.headers.authorization;
    // Node can collapse duplicate Authorization headers. Reject ambiguity and
    // remove transport copies so downstream handlers receive identity, not tokens.
    const rawHeaders = request.raw.rawHeaders;
    let authorizationCount = 0;
    for (let index = rawHeaders.length - 2; index >= 0; index -= 2) {
      if (rawHeaders[index]?.toLowerCase() === "authorization") {
        authorizationCount += 1;
        rawHeaders.splice(index, 2);
      }
    }
    if (authorizationCount > 1) {
      throw new AuthenticationError("MALFORMED_AUTHORIZATION");
    }
    const identity = await authenticateAuthorizationHeader(
      verifier,
      authorization,
    );
    return handler(identity, request, reply);
  };
}
