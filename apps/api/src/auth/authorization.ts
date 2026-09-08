export interface AuthenticatedIdentity {
  readonly userId: string;
}

export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthenticatedIdentity>;
}

const authenticationMessages = {
  MISSING_AUTHORIZATION: "Authorization is required.",
  MALFORMED_AUTHORIZATION: "Authorization must contain one Bearer token.",
  INVALID_ACCESS_TOKEN: "Access token verification failed.",
  INVALID_VERIFIED_IDENTITY: "Verified access token has no usable subject.",
} as const;

export type AuthenticationErrorReason = keyof typeof authenticationMessages;

export class AuthenticationError extends Error {
  constructor(readonly reason: AuthenticationErrorReason) {
    super(authenticationMessages[reason]);
    this.name = "AuthenticationError";
  }
}

export function parseBearerAuthorization(
  header: string | null | undefined,
): string {
  if (header === undefined || header === null) {
    throw new AuthenticationError("MISSING_AUTHORIZATION");
  }
  // Only horizontal whitespace is accepted; combined headers and extra tokens
  // cannot be interpreted as a single credential.
  const match = /^[\t ]*Bearer[\t ]+([A-Za-z0-9._~+/-]+=*)[\t ]*$/i.exec(
    header,
  );
  const token = match?.[1];
  if (token === undefined || /[\r\n]/.test(header)) {
    throw new AuthenticationError("MALFORMED_AUTHORIZATION");
  }
  return token;
}

export function authenticateAuthorizationHeader(
  verifier: AccessTokenVerifier,
  header: string | null | undefined,
): Promise<AuthenticatedIdentity> {
  return verifier.verifyAccessToken(parseBearerAuthorization(header));
}
