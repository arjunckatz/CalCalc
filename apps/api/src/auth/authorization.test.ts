import { describe, expect, it, vi } from "vitest";

import {
  authenticateAuthorizationHeader,
  AuthenticationError,
  parseBearerAuthorization,
} from "./authorization.js";

describe("parseBearerAuthorization", () => {
  it.each(["Bearer", "bearer", "bEaReR"])("accepts the %s scheme", (scheme) => {
    expect(parseBearerAuthorization(`${scheme} header.payload.signature`)).toBe(
      "header.payload.signature",
    );
  });

  it("accepts horizontal whitespace around a single credential", () => {
    expect(parseBearerAuthorization(" \tBearer \t abc_DEF-123.ghi== \t")).toBe(
      "abc_DEF-123.ghi==",
    );
  });

  it.each([undefined, null])("rejects missing authorization: %s", (header) => {
    expect(() => parseBearerAuthorization(header)).toThrow(AuthenticationError);
    expect(() => parseBearerAuthorization(header)).toThrow(
      expect.objectContaining({ reason: "MISSING_AUTHORIZATION" }),
    );
  });

  it.each([
    "",
    " \t ",
    "Bearer",
    "Bearer ",
    "Basic private-token",
    "Bearerprivate-token",
    "Bearer private-token another-token",
    "Bearer private-token, Bearer another-token",
    "Bearer private-token,another-token",
    'Bearer "private-token"',
    "Bearer private-token\n",
    "Bearer private-token\r\nX-User: other-user",
  ])(
    "rejects malformed authorization (%#) without exposing credentials",
    (header) => {
      let caught: unknown;
      try {
        parseBearerAuthorization(header);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AuthenticationError);
      expect(caught).toMatchObject({ reason: "MALFORMED_AUTHORIZATION" });
      expect(String(caught)).not.toContain("private-token");
      expect(JSON.stringify(caught)).not.toContain("private-token");
    },
  );
});

describe("authenticateAuthorizationHeader", () => {
  it("passes only the parsed token to the verifier and returns its identity", async () => {
    const identity = { userId: "verified-user-a" };
    const verifier = { verifyAccessToken: vi.fn(async () => identity) };

    expect(
      await authenticateAuthorizationHeader(verifier, "Bearer token-a"),
    ).toBe(identity);
    expect(verifier.verifyAccessToken).toHaveBeenCalledExactlyOnceWith(
      "token-a",
    );
  });

  it("does not call the verifier when parsing fails", () => {
    const verifier = { verifyAccessToken: vi.fn() };
    expect(() =>
      authenticateAuthorizationHeader(verifier, "Basic token-a"),
    ).toThrow(AuthenticationError);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("propagates an authentication failure without producing an identity", async () => {
    const failure = new AuthenticationError("INVALID_ACCESS_TOKEN");
    const verifier = { verifyAccessToken: vi.fn().mockRejectedValue(failure) };
    await expect(
      authenticateAuthorizationHeader(verifier, "Bearer token-a"),
    ).rejects.toBe(failure);
  });
});
