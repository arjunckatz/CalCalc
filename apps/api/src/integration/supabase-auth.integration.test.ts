import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  authenticateAuthorizationHeader,
  AuthenticationError,
  createSupabaseAccessTokenVerifier,
} from "../index.js";

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const publishableKey = requiredEnvironment("SUPABASE_PUBLISHABLE_KEY");
const secretKey = requiredEnvironment("SUPABASE_SECRET_KEY");

const adminClient = fixtureClient(secretKey);
const verifier = createSupabaseAccessTokenVerifier({
  supabaseUrl,
  supabasePublishableKey: publishableKey,
});
const createdUserIds: string[] = [];
interface Account {
  readonly id: string;
  readonly token: string;
}
let accountA: Account;
let accountB: Account;

describe("production Supabase authenticated identity boundary", () => {
  beforeAll(async () => {
    accountA = await createAccount("a");
    accountB = await createAccount("b");
  });

  afterAll(async () => {
    const failures: Error[] = [];
    // No profiles or ledger rows are created by this identity-only suite.
    for (const id of createdUserIds) {
      try {
        const { error } = await adminClient.auth.admin.deleteUser(id);
        if (error !== null)
          failures.push(new Error("Auth fixture deletion failed."));
      } catch {
        failures.push(new Error("Auth fixture deletion request failed."));
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Auth fixture cleanup failed.");
  });

  it("verifies User A's real access token through the production boundary", async () => {
    expect(
      await authenticateAuthorizationHeader(
        verifier,
        `Bearer ${accountA.token}`,
      ),
    ).toEqual({
      userId: accountA.id,
    });
  });

  it("keeps independently signed-in users distinct when sharing the verifier", async () => {
    expect(accountA.id).not.toBe(accountB.id);
    const [identityB, identityA] = await Promise.all([
      authenticateAuthorizationHeader(verifier, `Bearer ${accountB.token}`),
      authenticateAuthorizationHeader(verifier, `Bearer ${accountA.token}`),
    ]);
    expect(identityB).toEqual({ userId: accountB.id });
    expect(identityA).toEqual({ userId: accountA.id });
  });

  it("rejects a tampered signature without exposing the access token", async () => {
    const parts = accountA.token.split(".");
    const signature = parts[2];
    if (
      parts.length !== 3 ||
      signature === undefined ||
      signature.length === 0
    ) {
      throw new Error("Expected a three-part Auth access token.");
    }
    // Change the first signature character, avoiding insignificant trailing bits.
    parts[2] = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    const tampered = parts.join(".");
    const attempt = authenticateAuthorizationHeader(
      verifier,
      `Bearer ${tampered}`,
    );
    await expect(attempt).rejects.toBeInstanceOf(AuthenticationError);
    await expect(attempt).rejects.toMatchObject({
      reason: "INVALID_ACCESS_TOKEN",
    });
    await attempt.catch((error: AuthenticationError) => {
      expect(String(error)).not.toContain(tampered);
      expect(String(error)).not.toContain(accountA.token);
      expect(JSON.stringify(error)).not.toContain(tampered);
      expect(error.cause).toBeUndefined();
    });
  });

  it("cannot override User A's verified subject with an unrelated body userId", async () => {
    const unrelatedBody = { userId: accountB.id };
    const identity = await authenticateAuthorizationHeader(
      verifier,
      `Bearer ${accountA.token}`,
    );
    expect(identity).toEqual({ userId: accountA.id });
    expect(identity.userId).not.toBe(unrelatedBody.userId);
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is required for the Supabase Auth integration test.`,
    );
  }
  return value;
}

function fixtureClient(key: string) {
  return createClient(supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function createAccount(label: string): Promise<Account> {
  const credentials = {
    email: `cal-calc-m3b-${label}-${randomUUID()}@example.invalid`,
    password: `CalCalc-${randomUUID()}-Aa1!`,
  };
  const created = await adminClient.auth.admin.createUser({
    ...credentials,
    email_confirm: true,
  });
  if (created.error !== null || created.data.user === null) {
    throw new Error("Auth fixture user creation failed.");
  }
  createdUserIds.push(created.data.user.id);
  const userClient = fixtureClient(publishableKey);
  const signedIn = await userClient.auth.signInWithPassword(credentials);
  if (
    signedIn.error !== null ||
    signedIn.data.session === null ||
    signedIn.data.user === null
  ) {
    throw new Error("Auth fixture sign-in failed.");
  }
  expect(signedIn.data.user.id).toBe(created.data.user.id);
  return {
    id: created.data.user.id,
    token: signedIn.data.session.access_token,
  };
}
