import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { acceptCalendarContext } from "../../calendar-context.js";
import type { FoodDayTargetResolutionInput } from "../../resolve-food-day-target.js";
import {
  createOpenAIFoodDayTargetModel,
  OpenAIFoodDayTargetModelError,
} from "./openai-food-day-target-model.js";

const calendar = acceptCalendarContext({
  currentLocalDateTime: "2026-10-14T08:00:00+05:30",
  timeZone: "Asia/Kolkata",
});
if (calendar === null) throw new Error("Test calendar missing.");
const input: FoodDayTargetResolutionInput = {
  message: "  Actually make that one roti.  ",
  calendarContext: calendar,
  routing: {
    calendarContext: calendar,
    activeDayToken: "day_snapshot_1",
    today: { dayTokens: ["day_snapshot_1"], hasMore: true },
    yesterday: { dayTokens: [], hasMore: false },
    recentDays: { dayTokens: [], hasMoreTurns: true },
    days: [
      {
        token: "day_snapshot_1",
        localDate: "2026-10-14",
        status: "OPEN",
        completeness: "UNKNOWN",
        openedAt: "2026-10-14T02:30:00Z",
        sources: ["ACTIVE_POINTER"],
      },
    ],
    recentEntryReferences: {
      items: [],
      hasMore: true,
      candidateDayScopeComplete: false,
    },
    bounds: { daysPerDate: 8, recentResolvedTurns: 8, entryReferences: 16 },
  },
};

function mockClient(outputText: unknown, status = "completed") {
  const create = vi.fn(async (request: unknown) => {
    void request;
    return { status, output: [], output_text: outputText };
  });
  return { create, client: { responses: { create } } as unknown as OpenAI };
}

describe("OpenAI target adapter", () => {
  it.each([
    { kind: "EXISTING_DAY", dayToken: "day_snapshot_1" },
    { kind: "EXISTING_ENTRY_REFERENCE", entryToken: "entry_snapshot_1" },
    { kind: "DATE_TARGET", localDate: "2026-10-10" },
    { kind: "DAYLESS" },
    { kind: "CLARIFY", question: "Which day did you mean?" },
  ])(
    "parses strict structured $kind without executing tools",
    async (decision) => {
      const { create, client } = mockClient(JSON.stringify({ decision }));
      const model = createOpenAIFoodDayTargetModel({
        client,
        model: "injected-model",
      });
      expect(await model.decide(input)).toEqual(decision);
      expect(create).toHaveBeenCalledTimes(1);
      const request = create.mock.calls[0]![0];
      expect(request).toMatchObject({
        model: "injected-model",
        store: false,
        text: { format: { type: "json_schema", strict: true } },
      });
      expect(request).not.toHaveProperty("tools");
      expect(request).not.toHaveProperty("previous_response_id");
      const sent = request as { input: { content: string }[] };
      const context = JSON.parse(sent.input[0]!.content) as {
        canonicalRoutingSnapshot: typeof input.routing;
      };
      expect(context.canonicalRoutingSnapshot.today?.hasMore).toBe(true);
      expect(context.canonicalRoutingSnapshot.recentDays.hasMoreTurns).toBe(
        true,
      );
      expect(
        context.canonicalRoutingSnapshot.recentEntryReferences,
      ).toMatchObject({
        hasMore: true,
        candidateDayScopeComplete: false,
      });
      expect(sent.input[1]!.content).toBe(input.message);
    },
  );

  it.each([
    "",
    "not json",
    "{}",
    "[]",
    '{"decision":null}',
    '{"decision":{"kind":"DAYLESS"},"extra":1}',
    '{"decision":{"kind":"OTHER"}}',
    '{"decision":{"kind":"DAYLESS","extra":true}}',
  ])("rejects malformed provider envelope %s", async (text) => {
    const { client } = mockClient(text);
    await expect(
      createOpenAIFoodDayTargetModel({ client, model: "m" }).decide(input),
    ).rejects.toMatchObject({ reason: "INVALID_RESPONSE" });
  });

  it("rejects incomplete responses and sanitizes SDK failures", async () => {
    const incomplete = mockClient(
      '{"decision":{"kind":"DAYLESS"}}',
      "incomplete",
    );
    await expect(
      createOpenAIFoodDayTargetModel({
        client: incomplete.client,
        model: "m",
      }).decide(input),
    ).rejects.toMatchObject({ reason: "INVALID_RESPONSE" });
    const create = vi.fn(async () => {
      throw new Error("secret bearer token");
    });
    const client = { responses: { create } } as unknown as OpenAI;
    const error = await createOpenAIFoodDayTargetModel({ client, model: "m" })
      .decide(input)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(OpenAIFoodDayTargetModelError);
    expect((error as Error).message).not.toContain("secret bearer token");
    expect((error as Error).cause).toBeUndefined();
  });

  it("rejects an unexpected provider tool call", async () => {
    const create = vi.fn(async () => ({
      status: "completed",
      output_text: '{"decision":{"kind":"DAYLESS"}}',
      output: [{ type: "function_call", name: "LOG_FOOD", arguments: "{}" }],
    }));
    const client = { responses: { create } } as unknown as OpenAI;
    await expect(
      createOpenAIFoodDayTargetModel({ client, model: "m" }).decide(input),
    ).rejects.toMatchObject({ reason: "INVALID_RESPONSE" });
  });
});
