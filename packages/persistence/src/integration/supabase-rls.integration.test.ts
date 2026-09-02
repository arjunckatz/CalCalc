import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface AccountCredentials {
  readonly email: string;
  readonly password: string;
}

interface AuthenticatedAccount extends AccountCredentials {
  readonly id: string;
  readonly client: SupabaseClient;
}

interface SupabaseErrorLike {
  readonly message: string;
  readonly code?: string | undefined;
}

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const publishableKey = requiredEnvironment("SUPABASE_PUBLISHABLE_KEY");
const secretKey = requiredEnvironment("SUPABASE_SECRET_KEY");

const adminClient = testClient(secretKey);
const accountAClient = testClient(publishableKey);
const accountBClient = testClient(publishableKey);
const anonymousClient = testClient(publishableKey);
const accountACredentials = testCredentials("account-a");
const accountBCredentials = testCredentials("account-b");
const createdUserIds: string[] = [];

const dayAId = randomUUID();
const dayBId = randomUUID();
const entryAId = randomUUID();
const operationAId = randomUUID();

let accountA: AuthenticatedAccount;
let accountB: AuthenticatedAccount;

describe.sequential("Supabase Auth account isolation through RLS", () => {
  beforeAll(async () => {
    accountA = await createAndSignInAccount(
      adminClient,
      accountAClient,
      accountACredentials,
      createdUserIds,
    );
    accountB = await createAndSignInAccount(
      adminClient,
      accountBClient,
      accountBCredentials,
      createdUserIds,
    );
  });

  afterAll(async () => {
    await cleanupWithAdmin(adminClient, createdUserIds);
  });

  it("isolates profile reads, updates, and ownership claims", async () => {
    const inserted = await accountA.client
      .from("profiles")
      .insert({ user_id: accountA.id })
      .select("user_id, updated_at")
      .single();
    assertNoError(inserted.error, "Account A profile insert");
    expect(inserted.data.user_id).toBe(accountA.id);

    const selected = await accountA.client
      .from("profiles")
      .select("user_id")
      .eq("user_id", accountA.id)
      .single();
    assertNoError(selected.error, "Account A profile select");
    expect(selected.data.user_id).toBe(accountA.id);

    const updated = await accountA.client
      .from("profiles")
      .update({ updated_at: "2000-01-01T00:00:00.000Z" })
      .eq("user_id", accountA.id)
      .select("user_id, updated_at")
      .single();
    assertNoError(updated.error, "Account A profile update");
    const accountAUpdatedAt = updated.data.updated_at;

    await expectNoRows(
      accountB.client
        .from("profiles")
        .select("user_id")
        .eq("user_id", accountA.id),
      "Account B profile select",
    );
    await expectNoRows(
      accountB.client
        .from("profiles")
        .update({ updated_at: "1999-01-01T00:00:00.000Z" })
        .eq("user_id", accountA.id)
        .select("user_id"),
      "Account B profile update",
    );

    const unchanged = await accountA.client
      .from("profiles")
      .select("updated_at")
      .eq("user_id", accountA.id)
      .single();
    assertNoError(unchanged.error, "Account A profile verification");
    expect(unchanged.data.updated_at).toBe(accountAUpdatedAt);

    const claim = await accountA.client
      .from("profiles")
      .insert({ user_id: accountB.id })
      .select("user_id");
    expectRlsRejection(claim.data, claim.error, "cross-account profile insert");
  });

  it("isolates FoodDay reads, updates, and ownership claims", async () => {
    const insertedA = await accountA.client
      .from("food_days")
      .insert(foodDayRow(dayAId, accountA.id))
      .select("id, user_id, completeness")
      .single();
    assertNoError(insertedA.error, "Account A FoodDay insert");
    expect(insertedA.data).toMatchObject({
      id: dayAId,
      user_id: accountA.id,
      completeness: "UNKNOWN",
    });

    const selectedA = await accountA.client
      .from("food_days")
      .select("id")
      .eq("id", dayAId)
      .single();
    assertNoError(selectedA.error, "Account A FoodDay select");
    expect(selectedA.data.id).toBe(dayAId);

    const updatedA = await accountA.client
      .from("food_days")
      .update({ completeness: "PARTIAL" })
      .eq("id", dayAId)
      .select("id, completeness")
      .single();
    assertNoError(updatedA.error, "Account A FoodDay update");
    expect(updatedA.data.completeness).toBe("PARTIAL");

    await expectNoRows(
      accountB.client.from("food_days").select("id").eq("id", dayAId),
      "Account B FoodDay select",
    );
    await expectNoRows(
      accountB.client
        .from("food_days")
        .update({ completeness: "USER_DECLARED_COMPLETE" })
        .eq("id", dayAId)
        .select("id"),
      "Account B FoodDay update",
    );

    const unchanged = await accountA.client
      .from("food_days")
      .select("completeness")
      .eq("id", dayAId)
      .single();
    assertNoError(unchanged.error, "Account A FoodDay verification");
    expect(unchanged.data.completeness).toBe("PARTIAL");

    const claim = await accountA.client
      .from("food_days")
      .insert(foodDayRow(randomUUID(), accountB.id))
      .select("id");
    expectRlsRejection(claim.data, claim.error, "cross-account FoodDay insert");

    const insertedB = await accountB.client
      .from("food_days")
      .insert(foodDayRow(dayBId, accountB.id))
      .select("id")
      .single();
    assertNoError(insertedB.error, "Account B FoodDay insert");
    expect(insertedB.data.id).toBe(dayBId);
  });

  it("isolates FoodEntry reads, updates, and ownership claims", async () => {
    const inserted = await accountA.client
      .from("food_entries")
      .insert(foodEntryRow(entryAId, accountA.id, dayAId))
      .select("id, user_id, revision")
      .single();
    assertNoError(inserted.error, "Account A FoodEntry insert");
    expect(inserted.data).toMatchObject({
      id: entryAId,
      user_id: accountA.id,
      revision: 1,
    });

    const selected = await accountA.client
      .from("food_entries")
      .select("id")
      .eq("id", entryAId)
      .single();
    assertNoError(selected.error, "Account A FoodEntry select");
    expect(selected.data.id).toBe(entryAId);

    const updated = await accountA.client
      .from("food_entries")
      .update({ display_name: "Account A updated food", revision: 2 })
      .eq("id", entryAId)
      .select("id, display_name, revision")
      .single();
    assertNoError(updated.error, "Account A FoodEntry update");
    expect(updated.data).toMatchObject({
      display_name: "Account A updated food",
      revision: 2,
    });

    await expectNoRows(
      accountB.client.from("food_entries").select("id").eq("id", entryAId),
      "Account B FoodEntry select",
    );
    await expectNoRows(
      accountB.client
        .from("food_entries")
        .update({ display_name: "Account B tampered", revision: 3 })
        .eq("id", entryAId)
        .select("id"),
      "Account B FoodEntry update",
    );

    const unchanged = await accountA.client
      .from("food_entries")
      .select("display_name, revision")
      .eq("id", entryAId)
      .single();
    assertNoError(unchanged.error, "Account A FoodEntry verification");
    expect(unchanged.data).toMatchObject({
      display_name: "Account A updated food",
      revision: 2,
    });

    const claim = await accountA.client
      .from("food_entries")
      .insert(foodEntryRow(randomUUID(), accountB.id, dayBId))
      .select("id");
    expectRlsRejection(
      claim.data,
      claim.error,
      "cross-account FoodEntry insert",
    );
  });

  it("limits revision visibility and prevents authenticated updates", async () => {
    const ownRevisions = await accountA.client
      .from("food_entry_revisions")
      .select("id, revision, snapshot")
      .eq("food_entry_id", entryAId)
      .order("revision");
    assertNoError(ownRevisions.error, "Account A revision select");
    expect(ownRevisions.data.map((row) => row.revision)).toEqual([1, 2]);

    await expectNoRows(
      accountB.client
        .from("food_entry_revisions")
        .select("id")
        .eq("food_entry_id", entryAId),
      "Account B revision select",
    );

    const revision = ownRevisions.data[0];
    if (revision === undefined) throw new Error("Revision fixture is missing.");
    await expectNoRows(
      accountA.client
        .from("food_entry_revisions")
        .update({ snapshot: { tampered: true } })
        .eq("id", revision.id)
        .select("id"),
      "Account A revision update",
    );

    const unchanged = await accountA.client
      .from("food_entry_revisions")
      .select("snapshot")
      .eq("id", revision.id)
      .single();
    assertNoError(unchanged.error, "Account A revision verification");
    expect(unchanged.data.snapshot).toEqual(revision.snapshot);
  });

  it("prevents authenticated physical deletion of FoodEntries", async () => {
    await expectNoRows(
      accountA.client
        .from("food_entries")
        .delete()
        .eq("id", entryAId)
        .select("id"),
      "Account A physical FoodEntry delete",
    );

    const retained = await accountA.client
      .from("food_entries")
      .select("id, revision")
      .eq("id", entryAId)
      .single();
    assertNoError(retained.error, "Account A retained FoodEntry select");
    expect(retained.data).toMatchObject({ id: entryAId, revision: 2 });
  });

  it("isolates semantic operation reads and updates", async () => {
    const inserted = await accountA.client
      .from("semantic_operations")
      .insert({
        id: operationAId,
        user_id: accountA.id,
        operation_key: randomUUID(),
        request_fingerprint: randomUUID(),
      })
      .select("id, user_id, status")
      .single();
    assertNoError(inserted.error, "Account A semantic operation insert");
    expect(inserted.data).toMatchObject({
      id: operationAId,
      user_id: accountA.id,
      status: "PENDING",
    });

    const selected = await accountA.client
      .from("semantic_operations")
      .select("id, status")
      .eq("id", operationAId)
      .single();
    assertNoError(selected.error, "Account A semantic operation select");
    expect(selected.data.status).toBe("PENDING");

    await expectNoRows(
      accountB.client
        .from("semantic_operations")
        .select("id")
        .eq("id", operationAId),
      "Account B semantic operation select",
    );
    await expectNoRows(
      accountB.client
        .from("semantic_operations")
        .update({
          status: "SUCCEEDED",
          result: {},
          completed_at: new Date().toISOString(),
        })
        .eq("id", operationAId)
        .select("id"),
      "Account B semantic operation update",
    );

    const unchanged = await accountA.client
      .from("semantic_operations")
      .select("status, result, completed_at")
      .eq("id", operationAId)
      .single();
    assertNoError(unchanged.error, "Account A semantic operation verification");
    expect(unchanged.data).toMatchObject({
      status: "PENDING",
      result: null,
      completed_at: null,
    });

    const completed = await accountA.client
      .from("semantic_operations")
      .update({
        status: "SUCCEEDED",
        result: {},
        completed_at: new Date().toISOString(),
      })
      .eq("id", operationAId)
      .select("id, status, result")
      .single();
    assertNoError(completed.error, "Account A semantic operation update");
    expect(completed.data).toMatchObject({
      status: "SUCCEEDED",
      result: {},
    });
  });

  it("exposes no private ledger state to an anonymous client", async () => {
    for (const table of [
      "profiles",
      "food_days",
      "food_entries",
      "food_entry_revisions",
      "semantic_operations",
    ]) {
      await expectNoRows(
        anonymousClient.from(table).select("user_id"),
        `anonymous ${table} select`,
      );
    }
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is required for the Supabase RLS integration test.`,
    );
  }
  return value;
}

function testClient(key: string): SupabaseClient {
  return createClient(supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function testCredentials(label: string): AccountCredentials {
  const nonce = randomUUID();
  return {
    email: `cal-calc-m2b3-${label}-${nonce}@example.invalid`,
    password: `CalCalc-${randomUUID()}-Aa1!`,
  };
}

async function createAndSignInAccount(
  fixtureAdmin: SupabaseClient,
  userClient: SupabaseClient,
  credentials: AccountCredentials,
  cleanupUserIds: string[],
): Promise<AuthenticatedAccount> {
  const created = await fixtureAdmin.auth.admin.createUser({
    email: credentials.email,
    password: credentials.password,
    email_confirm: true,
  });
  assertNoError(created.error, `admin create ${credentials.email}`);
  if (created.data.user === null)
    throw new Error("Admin created no Auth user.");
  cleanupUserIds.push(created.data.user.id);

  const signedIn = await userClient.auth.signInWithPassword(credentials);
  assertNoError(signedIn.error, `sign in ${credentials.email}`);
  expect(signedIn.data.user.id).toBe(created.data.user.id);

  const authenticated = await userClient.auth.getUser();
  assertNoError(authenticated.error, `get authenticated ${credentials.email}`);
  expect(authenticated.data.user.id).toBe(created.data.user.id);

  return {
    ...credentials,
    id: created.data.user.id,
    client: userClient,
  };
}

function foodDayRow(id: string, userId: string) {
  return {
    id,
    user_id: userId,
    status: "OPEN",
    completeness: "UNKNOWN",
    calorie_target: "2100",
    protein_target: "120",
    local_date: "2026-09-02",
    timezone: "UTC",
  };
}

function foodEntryRow(id: string, userId: string, foodDayId: string) {
  const nutrition = { calories: "685.1075", protein: "41.0025" };
  return {
    id,
    user_id: userId,
    food_day_id: foodDayId,
    raw_user_description: "275 g label food",
    display_name: "Label food",
    quantity_amount: "275",
    quantity_unit: "GRAM",
    nutrition_basis_amount: "100",
    nutrition_basis_unit: "GRAM",
    nutrition_basis: { calories: "249.13", protein: "14.91" },
    derived_nutrition: nutrition,
    working_nutrition_override: null,
    working_nutrition: nutrition,
    evidence_class: "EXACT",
    status: "CONFIRMED_CONSUMED",
    revision: 1,
  };
}

function assertNoError(
  error: SupabaseErrorLike | null,
  context: string,
): asserts error is null {
  if (error !== null) {
    throw new Error(`${context} failed: ${error.message}`, { cause: error });
  }
}

async function expectNoRows(
  request: PromiseLike<{
    readonly data: unknown[] | null;
    readonly error: SupabaseErrorLike | null;
  }>,
  context: string,
): Promise<void> {
  const result = await request;
  assertNoError(result.error, context);
  expect(result.data).toEqual([]);
}

function expectRlsRejection(
  data: unknown,
  error: SupabaseErrorLike | null,
  context: string,
): void {
  expect(data, context).toBeNull();
  if (error === null) throw new Error(`${context} unexpectedly succeeded.`);
  expect(error.code, context).toBe("42501");
}

async function cleanupWithAdmin(
  fixtureAdmin: SupabaseClient,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const failures: Error[] = [];

  for (const table of [
    "food_entry_revisions",
    "food_entries",
    "semantic_operations",
    "food_days",
    "profiles",
  ]) {
    const result = await fixtureAdmin
      .from(table)
      .delete()
      .in("user_id", userIds);
    if (result.error !== null) {
      failures.push(
        new Error(`admin cleanup of ${table} failed: ${result.error.message}`),
      );
    }
  }

  for (const userId of userIds) {
    const result = await fixtureAdmin.auth.admin.deleteUser(userId);
    if (result.error !== null) {
      failures.push(
        new Error(`admin cleanup of Auth user failed: ${result.error.message}`),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Supabase RLS fixture cleanup failed.");
  }
}
