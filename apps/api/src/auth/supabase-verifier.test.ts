import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticateAuthorizationHeader,
  AuthenticationError,
} from "./authorization.js";
import { SupabaseAccessTokenVerifier } from "./supabase-verifier.js";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(() => ({
    auth: {
      getClaims: vi.fn(async () => ({
        data: { claims: { sub: "user-a" } },
        error: null,
      })),
    },
  })),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SupabaseAccessTokenVerifier", () => {
  it("uses verified sub only, ignoring metadata and unrelated requested identity", async () => {
    const claims = {
      sub: "verified-user-a",
      email: "user-b@example.invalid",
      userId: "user-b",
      user_metadata: { sub: "user-b", userId: "user-b" },
      role: "user-b",
    };
    const auth = {
      getClaims: vi.fn(async () => ({ data: { claims }, error: null })),
    };
    const verifier = new SupabaseAccessTokenVerifier(auth);
    const unrelatedBody = { userId: "user-b" };

    const identity = await authenticateAuthorizationHeader(
      verifier,
      "Bearer token-a",
    );
    expect(identity).toEqual({ userId: "verified-user-a" });
    expect(identity.userId).not.toBe(unrelatedBody.userId);
    expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith("token-a");
  });

  it.each(["returned", "thrown"])(
    "sanitizes %s SDK failures, including their causes",
    async (mode) => {
      const token = "private-access-token";
      const failure = new Error(`SDK detail: ${token}`, { cause: token });
      const auth = {
        getClaims: vi.fn(async () => {
          if (mode === "thrown") throw failure;
          return {
            data: { claims: { sub: "must-not-be-returned" } },
            error: failure,
          };
        }),
      };
      const attempt = new SupabaseAccessTokenVerifier(auth).verifyAccessToken(
        token,
      );
      await expect(attempt).rejects.toBeInstanceOf(AuthenticationError);
      await expect(attempt).rejects.toMatchObject({
        reason: "INVALID_ACCESS_TOKEN",
        message: "Access token verification failed.",
      });
      await attempt.catch((error: AuthenticationError) => {
        expect(error.cause).toBeUndefined();
        expect(String(error)).not.toContain(token);
        expect(JSON.stringify(error)).not.toContain(token);
      });
    },
  );

  it("rejects an absent verification result", async () => {
    const auth = {
      getClaims: vi.fn(async () => ({ data: null, error: null })),
    };
    await expect(
      new SupabaseAccessTokenVerifier(auth).verifyAccessToken("token"),
    ).rejects.toMatchObject({
      reason: "INVALID_ACCESS_TOKEN",
    });
  });

  it.each([undefined, null, "", " \t ", 42, {}, ["user-a"]])(
    "rejects an unusable verified subject (%#)",
    async (sub) => {
      const auth = {
        getClaims: vi.fn(async () => ({
          data: { claims: { sub } },
          error: null,
        })),
      };
      await expect(
        new SupabaseAccessTokenVerifier(auth).verifyAccessToken("token"),
      ).rejects.toMatchObject({
        reason: "INVALID_VERIFIED_IDENTITY",
      });
    },
  );

  it.each(["", " \t\n"])(
    "rejects blank direct tokens without using an implicit session (%#)",
    async (token) => {
      const auth = { getClaims: vi.fn() };
      await expect(
        new SupabaseAccessTokenVerifier(auth).verifyAccessToken(token),
      ).rejects.toMatchObject({
        reason: "INVALID_ACCESS_TOKEN",
      });
      expect(auth.getClaims).not.toHaveBeenCalled();
    },
  );
});

describe("createSupabaseAccessTokenVerifier", () => {
  it("does not create a client or network activity at module import", async () => {
    vi.resetModules();
    await import("../index.js");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("explicitly constructs independent publishable-key clients with session behavior disabled", async () => {
    const { createSupabaseAccessTokenVerifier } =
      await import("./supabase-verifier.js");
    const config = {
      supabaseUrl: "https://unused.invalid",
      supabasePublishableKey: "test-publishable-key",
    };
    const first = createSupabaseAccessTokenVerifier(config);
    const second = createSupabaseAccessTokenVerifier(config);
    expect(first).not.toBe(second);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith(
      config.supabaseUrl,
      config.supabasePublishableKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
    const clients = createClient.mock.results.map((result) => result.value);
    for (const client of clients)
      expect(client.auth.getClaims).not.toHaveBeenCalled();
    expect(await first.verifyAccessToken("token-a")).toEqual({
      userId: "user-a",
    });
    expect(clients[0]?.auth.getClaims).toHaveBeenCalledExactlyOnceWith(
      "token-a",
    );
    expect(clients[1]?.auth.getClaims).not.toHaveBeenCalled();
  });

  it.each([
    { supabaseUrl: "", supabasePublishableKey: "key" },
    { supabaseUrl: " \t ", supabasePublishableKey: "key" },
    { supabaseUrl: "https://unused.invalid", supabasePublishableKey: "" },
    { supabaseUrl: "https://unused.invalid", supabasePublishableKey: " \t " },
  ])(
    "rejects blank configuration before client construction (%#)",
    async (config) => {
      const { createSupabaseAccessTokenVerifier } =
        await import("./supabase-verifier.js");
      expect(() => createSupabaseAccessTokenVerifier(config)).toThrow(
        TypeError,
      );
      expect(createClient).not.toHaveBeenCalled();
    },
  );
});
