import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresSemanticOperationRepository,
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
} from "../index.js";

interface TestUser {
  readonly id: string;
  readonly email: string;
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL semantic-operation repository integration test.",
  );
}

const client = new Client({ connectionString: databaseUrl });
const repository = new PostgresSemanticOperationRepository(client);
const userA = testUser();
const userB = testUser();
let connected = false;

describe("PostgreSQL semantic-operation repository", () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await createFixtures(client, [userA, userB]);
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await cleanupFixtures(client, [userA.id, userB.id]);
    } finally {
      await client.end();
    }
  });

  it("claims, replays, isolates, and completes durable semantic operations", async () => {
    const operationKey = `log-meal-${randomUUID()}`;
    const fingerprint = `request-${randomUUID()}`;
    const firstId = randomUUID();

    const first = await repository.claim({
      id: firstId,
      userId: userA.id,
      operationKey,
      requestFingerprint: fingerprint,
    });
    expect(first.disposition).toBe("CREATED");
    expect(first.operation).toMatchObject({
      id: firstId,
      userId: userA.id,
      operationKey,
      requestFingerprint: fingerprint,
      status: "PENDING",
      result: null,
      error: null,
      completedAt: null,
    });

    const replay = await repository.claim({
      id: randomUUID(),
      userId: userA.id,
      operationKey,
      requestFingerprint: fingerprint,
    });
    expect(replay.disposition).toBe("EXISTING");
    expect(replay.operation).toEqual(first.operation);

    const count = await client.query<{ readonly count: string }>(
      `select count(*)::text as count
       from public.semantic_operations
       where user_id = $1
         and operation_key = $2`,
      [userA.id, operationKey],
    );
    expect(count.rows[0]?.count).toBe("1");

    const conflictingFingerprint = `request-${randomUUID()}`;
    await expect(
      repository.claim({
        id: randomUUID(),
        userId: userA.id,
        operationKey,
        requestFingerprint: conflictingFingerprint,
      }),
    ).rejects.toMatchObject({
      name: "SemanticOperationIdempotencyConflictError",
      operationKey,
      existingFingerprint: fingerprint,
      suppliedFingerprint: conflictingFingerprint,
    } satisfies Partial<SemanticOperationIdempotencyConflictError>);
    expect(await repository.findByKey(userA.id, operationKey)).toEqual(
      first.operation,
    );

    expect(await repository.findByKey(userB.id, operationKey)).toBeNull();
    const userBClaim = await repository.claim({
      id: randomUUID(),
      userId: userB.id,
      operationKey,
      requestFingerprint: `request-${randomUUID()}`,
    });
    expect(userBClaim.disposition).toBe("CREATED");
    expect(userBClaim.operation.userId).toBe(userB.id);

    const successResult = { entryId: randomUUID(), outcome: "CREATED" };
    const succeededAt = futureTimestamp(60_000);
    const succeeded = await repository.markSucceeded({
      userId: userA.id,
      operationKey,
      result: successResult,
      completedAt: succeededAt,
    });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(succeeded.result).toEqual(successResult);
    expect(succeeded.error).toBeNull();
    expect(new Date(succeeded.completedAt ?? "").toISOString()).toBe(
      succeededAt,
    );
    expect(await repository.findByKey(userA.id, operationKey)).toEqual(
      succeeded,
    );

    await expect(
      repository.markFailed({
        userId: userA.id,
        operationKey,
        error: { code: "LATE_FAILURE" },
        completedAt: futureTimestamp(120_000),
      }),
    ).rejects.toMatchObject({
      name: "SemanticOperationStateConflictError",
      operationKey,
      actualStatus: "SUCCEEDED",
    } satisfies Partial<SemanticOperationStateConflictError>);
    expect(await repository.findByKey(userA.id, operationKey)).toEqual(
      succeeded,
    );

    const failedKey = `failed-operation-${randomUUID()}`;
    await repository.claim({
      id: randomUUID(),
      userId: userA.id,
      operationKey: failedKey,
      requestFingerprint: `request-${randomUUID()}`,
    });
    const failedAt = futureTimestamp(180_000);
    const failed = await repository.markFailed({
      userId: userA.id,
      operationKey: failedKey,
      error: { code: "ESTIMATE_FAILED", retryable: false },
      completedAt: failedAt,
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.result).toBeNull();
    expect(failed.error).toEqual({
      code: "ESTIMATE_FAILED",
      retryable: false,
    });
    expect(new Date(failed.completedAt ?? "").toISOString()).toBe(failedAt);
    expect(await repository.findByKey(userA.id, failedKey)).toEqual(failed);
  });
});

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m2b5-${id}@example.invalid` };
}

function futureTimestamp(offsetMilliseconds: number): string {
  return new Date(Date.now() + offsetMilliseconds).toISOString();
}

async function createFixtures(
  database: Client,
  users: readonly [TestUser, TestUser],
): Promise<void> {
  await database.query(
    `insert into auth.users (
       instance_id,
       id,
       aud,
       role,
       email,
       encrypted_password,
       email_confirmed_at,
       raw_app_meta_data,
       raw_user_meta_data,
       created_at,
       updated_at
     ) values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
       ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [users[0].id, users[0].email, users[1].id, users[1].email],
  );
  await database.query(
    `insert into public.profiles (user_id) values ($1), ($2)`,
    [users[0].id, users[1].id],
  );
}

async function cleanupFixtures(
  database: Client,
  userIds: readonly string[],
): Promise<void> {
  const parameters = [userIds];
  await database.query(
    "delete from public.semantic_operations where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from public.profiles where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from auth.users where id = any($1::uuid[])",
    parameters,
  );
}
