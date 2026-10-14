import { randomUUID } from "node:crypto";

import { createFoodEntry, deleteFoodEntry } from "@cal-calc/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_RECENT_RESOLVED_TURNS,
  MAX_ROUTING_DAYS_PER_DATE,
  MAX_ROUTING_ENTRY_REFERENCES,
  PostgresAccountConversationTurnRepository,
  PostgresConversationRepository,
  PostgresFoodDayRepository,
  PostgresFoodEntryRepository,
} from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for routing-candidate integration.",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const conversations = new PostgresConversationRepository(pool);
const turns = new PostgresAccountConversationTurnRepository(pool);
const days = new PostgresFoodDayRepository(pool);
const entries = new PostgresFoodEntryRepository(pool);
const owner = randomUUID();
const other = randomUUID();
const sameDateIds = Array.from({ length: MAX_ROUTING_DAYS_PER_DATE + 1 }, () =>
  randomUUID(),
);
const priorDayId = randomUUID();
const otherDayId = randomUUID();
const entryIds = Array.from({ length: MAX_ROUTING_ENTRY_REFERENCES + 1 }, () =>
  randomUUID(),
);
const deletedEntryId = randomUUID();
const otherEntryId = randomUUID();
let fixtureReady = false;

describe("PostgreSQL owner-scoped routing candidate reads", () => {
  beforeAll(async () => {
    await pool.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
         created_at, updated_at
       ) values
         ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
         ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
      [
        owner,
        `routing-${owner}@example.invalid`,
        other,
        `routing-${other}@example.invalid`,
      ],
    );
    fixtureReady = true;
    for (const [index, id] of sameDateIds.entries()) {
      await pool.query(
        `insert into public.food_days
         (id, user_id, status, completeness, calorie_target, protein_target,
          local_date, timezone, opened_at)
         values ($1, $2, 'OPEN', 'UNKNOWN', 2000, 100, '2026-10-13', 'UTC', $3::timestamptz)`,
        [id, owner, new Date(Date.UTC(2026, 9, 13, 0, 0, index)).toISOString()],
      );
    }
    await pool.query(
      `insert into public.food_days
       (id, user_id, status, completeness, calorie_target, protein_target,
        local_date, timezone)
       values
       ($1, $2, 'CLOSED', 'USER_DECLARED_COMPLETE', 2000, 100, '2026-10-12', 'UTC'),
       ($3, $4, 'OPEN', 'UNKNOWN', 2000, 100, '2026-10-13', 'UTC')`,
      [priorDayId, owner, otherDayId, other],
    );
    const conversation = await conversations.getOrCreate(owner);
    await conversations.compareAndSetActiveDay({
      userId: owner,
      expectedVersion: conversation.version,
      activeFoodDayId: priorDayId,
    });
    await conversations.getOrCreate(other);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    if (fixtureReady) {
      for (const table of [
        "conversation_turns",
        "food_entry_revisions",
        "food_entries",
        "conversations",
        "food_days",
      ] as const) {
        try {
          await pool.query(
            `delete from public.${table} where user_id = any($1::uuid[])`,
            [[owner, other]],
          );
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await pool.query("delete from auth.users where id = any($1::uuid[])", [
          [owner, other],
        ]);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Routing fixture cleanup failed.");
  });

  it("preserves same-date multiplicity, owner isolation, a closed prior day, and N+1 overflow", async () => {
    const current = await days.listRoutingCandidatesByLocalDate(
      owner,
      "2026-10-13",
    );
    expect(current.items).toHaveLength(MAX_ROUTING_DAYS_PER_DATE);
    expect(current.hasMore).toBe(true);
    expect(current.items.map((item) => item.foodDay.id)).toEqual(
      sameDateIds.slice(0, MAX_ROUTING_DAYS_PER_DATE),
    );
    expect(current.items.every((item) => item.userId === owner)).toBe(true);
    expect(current.items.map((item) => item.foodDay.id)).not.toContain(
      otherDayId,
    );

    const prior = await days.listRoutingCandidatesByLocalDate(
      owner,
      "2026-10-12",
    );
    expect(prior).toMatchObject({
      hasMore: false,
      items: [
        {
          userId: owner,
          foodDay: { id: priorDayId, status: "CLOSED" },
          completeness: "USER_DECLARED_COMPLETE",
        },
      ],
    });
    expect(
      await days.listRoutingCandidatesByLocalDate(owner, "2026-10-11"),
    ).toEqual({ items: [], hasMore: false });
    expect(
      (
        await days.listRoutingCandidatesByLocalDate(other, "2026-10-13")
      ).items.map((item) => item.foodDay.id),
    ).toEqual([otherDayId]);
    expect((await conversations.findByUser(owner))?.activeFoodDayId).toBe(
      priorDayId,
    );
    expect(
      (await days.findOwnedByIds(owner, [priorDayId, otherDayId])).map(
        (item) => item.foodDay.id,
      ),
    ).toEqual([priorDayId]);
  });

  it("excludes pending/dayless/cross-owner turns, retains duplicate targets, and detects the recent window", async () => {
    const claim = async (userId: string, message: string) => {
      const turnKey = `routing-${randomUUID()}`;
      const requestFingerprint = randomUUID();
      await turns.claimPending({
        id: randomUUID(),
        userId,
        turnKey,
        requestFingerprint,
        userMessage: message,
        calendarContext: null,
      });
      return { userId, turnKey, requestFingerprint };
    };
    const pending = await claim(owner, "pending target");
    await turns.setResolvedTarget({ ...pending, foodDayId: priorDayId });
    const pendingId = (await turns.findByKey(owner, pending.turnKey))?.id;
    const dayless = await claim(owner, "dayless completed");
    await turns.markCompleted({ ...dayless, response: "answer" });
    const daylessId = (await turns.findByKey(owner, dayless.turnKey))?.id;
    const foreign = await claim(other, "other owner completed");
    await turns.setResolvedTarget({ ...foreign, foodDayId: otherDayId });
    await turns.markCompleted({ ...foreign, response: "answer" });
    const foreignId = (await turns.findByKey(other, foreign.turnKey))?.id;
    expect([pendingId, daylessId, foreignId]).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);

    for (let index = 0; index < MAX_RECENT_RESOLVED_TURNS + 1; index += 1) {
      const turn = await claim(owner, `resolved ${index}`);
      await turns.setResolvedTarget({
        ...turn,
        foodDayId: index % 2 === 0 ? priorDayId : sameDateIds[0]!,
      });
      await turns.markCompleted({ ...turn, response: `answer ${index}` });
    }
    const result = await turns.listRecentResolvedTargets(owner);
    expect(result.items).toHaveLength(MAX_RECENT_RESOLVED_TURNS);
    expect(result.hasMore).toBe(true);
    expect(new Set(result.items.map((item) => item.foodDayId))).toEqual(
      new Set([priorDayId, sameDateIds[0]]),
    );
    const direct = await pool.query<{ id: string }>(
      `select id from public.conversation_turns
       where user_id = $1 and status = 'COMPLETED'
         and resolved_food_day_id is not null
       order by created_at desc, id desc limit $2`,
      [owner, MAX_RECENT_RESOLVED_TURNS],
    );
    expect(result.items.map((item) => item.turnId)).toEqual(
      direct.rows.map((row) => row.id),
    );
    expect(result.items.map((item) => item.turnId)).not.toContain(daylessId);
    expect(result.items.map((item) => item.turnId)).not.toContain(pendingId);
    expect(result.items.map((item) => item.turnId)).not.toContain(foreignId);
  });

  it("returns only canonical owned entries from candidate days and excludes logical deletion", async () => {
    const makeEntry = (
      id: string,
      foodDayId: string,
      status: "PLANNED" | "DISCARDED" = "PLANNED",
    ) =>
      createFoodEntry({
        id,
        foodDayId,
        rawUserDescription: "one slice",
        displayName: "Toast",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "75" },
        },
        evidenceClass: "EXACT",
        status,
      });
    for (const [index, id] of entryIds.entries()) {
      await entries.create({
        userId: owner,
        entry: makeEntry(
          id,
          priorDayId,
          index === entryIds.length - 1 ? "DISCARDED" : "PLANNED",
        ),
      });
    }
    const createdDeleted = await entries.create({
      userId: owner,
      entry: makeEntry(deletedEntryId, priorDayId),
    });
    const deletion = deleteFoodEntry(createdDeleted.entry, {
      expectedRevision: 1,
      deletedAt: "2026-10-13T00:00:00.000Z",
    });
    if (!deletion.ok)
      throw new Error("Unexpected deletion conflict in fixture.");
    await entries.update({
      userId: owner,
      expectedRevision: 1,
      entry: deletion.value,
    });
    await entries.create({
      userId: other,
      entry: makeEntry(otherEntryId, otherDayId),
    });

    const result = await entries.listRecentRoutingReferences(owner, [
      priorDayId,
      otherDayId,
    ]);
    expect(result.items).toHaveLength(MAX_ROUTING_ENTRY_REFERENCES);
    expect(result.hasMore).toBe(true);
    expect(
      result.items.every(
        (item) => item.userId === owner && item.entry.foodDayId === priorDayId,
      ),
    ).toBe(true);
    expect(result.items.map((item) => item.entry.id)).not.toContain(
      otherEntryId,
    );
    expect(result.items.map((item) => item.entry.id)).not.toContain(
      deletedEntryId,
    );
    expect(result.items.some((item) => item.entry.status === "DISCARDED")).toBe(
      true,
    );
    const direct = await pool.query<{ id: string }>(
      `select id from public.food_entries
       where user_id = $1 and food_day_id = $2 and deleted_at is null
       order by created_at desc, id desc limit $3`,
      [owner, priorDayId, MAX_ROUTING_ENTRY_REFERENCES],
    );
    expect(result.items.map((item) => item.entry.id)).toEqual(
      direct.rows.map((row) => row.id),
    );
    const discarded = await entries.findById(owner, entryIds.at(-1)!);
    expect(discarded?.entry.status).toBe("DISCARDED");
    expect(
      await entries.listRecentRoutingReferences(owner, [otherDayId]),
    ).toEqual({ items: [], hasMore: false });
    await expect(
      entries.create({
        userId: owner,
        entry: makeEntry(randomUUID(), otherDayId),
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
