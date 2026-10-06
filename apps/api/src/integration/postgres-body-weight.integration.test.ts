import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import {
  PostgresBodyWeightRepository,
  SemanticOperationIdempotencyConflictError,
} from "@cal-calc/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  authenticateAuthorizationHeader,
  createPostgresRuntime,
  createSupabaseAccessTokenVerifier,
} from "../index.js";
import { logBodyWeightMutation } from "../mutations/log-body-weight.js";
import { parseIdempotencyKey } from "../mutations/mutation-identity.js";

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const publishableKey = requiredEnvironment("SUPABASE_PUBLISHABLE_KEY");
const secretKey = requiredEnvironment("SUPABASE_SECRET_KEY");
const runtime = createPostgresRuntime({
  connectionString: requiredEnvironment("DATABASE_URL"),
});
const admin = client(secretKey);
const verifier = createSupabaseAccessTokenVerifier({
  supabaseUrl,
  supabasePublishableKey: publishableKey,
});
const createdUserIds: string[] = [];

interface Account {
  readonly id: string;
  readonly token: string;
  readonly client: ReturnType<typeof client>;
}

let a: Account;
let b: Account;

describe("real owned body-weight observation and exactly-once mutation", () => {
  beforeAll(async () => {
    a = await createAccount("a");
    b = await createAccount("b");
  });

  afterAll(async () => {
    const failures: Error[] = [];
    async function cleanup(label: string, work: () => Promise<unknown>) {
      try {
        await work();
      } catch {
        failures.push(new Error(`${label} cleanup failed.`));
      }
    }
    if (createdUserIds.length > 0) {
      await cleanup("body-weight rows", () =>
        runtime.pool.query(
          "delete from public.body_weight_entries where user_id = any($1::uuid[])",
          [createdUserIds],
        ),
      );
      await cleanup("semantic operations", () =>
        runtime.pool.query(
          "delete from public.semantic_operations where user_id = any($1::uuid[])",
          [createdUserIds],
        ),
      );
      for (const id of createdUserIds) {
        await cleanup("Auth user", async () => {
          const result = await admin.auth.admin.deleteUser(id);
          if (result.error !== null) throw new Error("Auth deletion failed.");
        });
      }
    }
    await cleanup("PostgreSQL runtime", () => runtime.close());
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Body-weight integration cleanup failed.",
      );
  });

  it("stores exact kg, replays once, allows another same-day observation, and isolates users", async () => {
    const identityA = await authenticateAuthorizationHeader(
      verifier,
      `Bearer ${a.token}`,
    );
    const identityB = await authenticateAuthorizationHeader(
      verifier,
      `Bearer ${b.token}`,
    );
    expect(identityA.userId).toBe(a.id);
    expect(identityB.userId).toBe(b.id);
    const command = {
      localDate: "2026-10-04",
      sourceValue: "180.2500",
      sourceUnit: "LB" as const,
    };
    const firstKey = parseIdempotencyKey(randomUUID());
    const first = await logBodyWeightMutation(
      { transactionRunner: runtime.transactionRunner },
      { trustedUserId: identityA.userId, idempotencyKey: firstKey, command },
    );
    expect(first.disposition).toBe("CREATED");
    expect(first.weightEntry).toMatchObject({
      localDate: "2026-10-04",
      sourceValue: "180.25",
      sourceUnit: "LB",
      weightKg: "81.7600246925",
    });
    const replay = await logBodyWeightMutation(
      { transactionRunner: runtime.transactionRunner },
      {
        trustedUserId: identityA.userId,
        idempotencyKey: firstKey,
        command: { ...command, sourceValue: "180.25" },
      },
    );
    expect(replay).toEqual({ ...first, disposition: "REPLAYED" });
    await expect(
      logBodyWeightMutation(
        { transactionRunner: runtime.transactionRunner },
        {
          trustedUserId: identityA.userId,
          idempotencyKey: firstKey,
          command: { ...command, sourceValue: "181" },
        },
      ),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);

    const second = await logBodyWeightMutation(
      { transactionRunner: runtime.transactionRunner },
      {
        trustedUserId: identityA.userId,
        idempotencyKey: parseIdempotencyKey(randomUUID()),
        command: { ...command, sourceValue: "80.2", sourceUnit: "KG" },
      },
    );
    expect(second.weightEntry.id).not.toBe(first.weightEntry.id);
    expect(second.weightEntry.localDate).toBe(first.weightEntry.localDate);
    expect(second.weightEntry.weightKg).toBe("80.2");

    const bOwn = await logBodyWeightMutation(
      { transactionRunner: runtime.transactionRunner },
      { trustedUserId: identityB.userId, idempotencyKey: firstKey, command },
    );
    expect(bOwn.disposition).toBe("CREATED");
    expect(bOwn.weightEntry.id).not.toBe(first.weightEntry.id);

    const stored = await runtime.pool.query(
      `select id, user_id, local_date::text as local_date,
              source_value::text as source_value, source_unit,
              weight_kg::text as weight_kg
       from public.body_weight_entries where user_id = $1 order by id`,
      [a.id],
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows).toContainEqual({
      id: first.weightEntry.id,
      user_id: a.id,
      local_date: "2026-10-04",
      source_value: "180.25",
      source_unit: "LB",
      weight_kg: "81.7600246925",
    });
    const operations = await runtime.pool.query(
      `select status, result from public.semantic_operations
       where user_id = $1 and result ->> 'kind' = 'BODY_WEIGHT_ENTRY_CREATED'`,
      [a.id],
    );
    expect(operations.rows).toHaveLength(2);
    expect(operations.rows.every((row) => row.status === "SUCCEEDED")).toBe(
      true,
    );

    expect(
      await new PostgresBodyWeightRepository(runtime.pool).findById(
        b.id,
        first.weightEntry.id,
      ),
    ).toBeNull();
    const bRead = await b.client
      .from("body_weight_entries")
      .select("id, local_date")
      .eq("id", first.weightEntry.id);
    expect(bRead.error).toBeNull();
    expect(bRead.data).toEqual([]);
    const ownRead = await a.client
      .from("body_weight_entries")
      .select("id")
      .eq("id", first.weightEntry.id);
    expect(ownRead.error).toBeNull();
    expect(ownRead.data).toEqual([{ id: first.weightEntry.id }]);
    const bOwnRead = await b.client
      .from("body_weight_entries")
      .select("id")
      .eq("id", bOwn.weightEntry.id);
    expect(bOwnRead.error).toBeNull();
    expect(bOwnRead.data).toEqual([{ id: bOwn.weightEntry.id }]);
    const ownershipClaim = await b.client.from("body_weight_entries").insert({
      id: randomUUID(),
      user_id: a.id,
      local_date: "2026-10-04",
      source_value: "80.2",
      source_unit: "KG",
      weight_kg: "80.2",
    });
    expect(ownershipClaim.error).not.toBeNull();
    const finalCount = await runtime.pool.query(
      "select count(*)::int as count from public.body_weight_entries where user_id = $1",
      [a.id],
    );
    expect(finalCount.rows).toEqual([{ count: 2 }]);
  });

  it("rejects invalid direct PostgreSQL numeric data", async () => {
    for (const [sourceValue, weightKg] of [
      ["0", "0"],
      ["180", "80"],
    ]) {
      await expect(
        runtime.pool.query(
          `insert into public.body_weight_entries
             (id, user_id, local_date, source_value, source_unit, weight_kg)
           values ($1, $2, '2026-10-04', $3::numeric, 'LB', $4::numeric)`,
          [randomUUID(), a.id, sourceValue, weightKg],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});

async function createAccount(label: string): Promise<Account> {
  const credentials = {
    email: `cal-calc-weight-${label}-${randomUUID()}@example.invalid`,
    password: `CalCalc-${randomUUID()}-Aa1!`,
  };
  const created = await admin.auth.admin.createUser({
    ...credentials,
    email_confirm: true,
  });
  if (created.error !== null || created.data.user === null)
    throw new Error("Auth fixture creation failed.");
  createdUserIds.push(created.data.user.id);
  const accountClient = client(publishableKey);
  const signedIn = await accountClient.auth.signInWithPassword(credentials);
  if (
    signedIn.error !== null ||
    signedIn.data.session === null ||
    signedIn.data.user === null
  )
    throw new Error("Auth fixture sign-in failed.");
  return {
    id: signedIn.data.user.id,
    token: signedIn.data.session.access_token,
    client: accountClient,
  };
}

function client(key: string) {
  return createClient(supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`${name} is required for body-weight integration.`);
  return value;
}
