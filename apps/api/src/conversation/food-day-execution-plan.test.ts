import { describe, expect, it } from "vitest";

import type { FoodDayState } from "../state/build-food-day-state.js";
import {
  createFoodDayExecutionPlan,
  parseFoodDayExecutionPlan,
} from "./food-day-execution-plan.js";

const foodDayId = "20000000-0000-4000-8000-000000000001";
const entryId = "30000000-0000-4000-8000-000000000001";
const otherEntryId = "30000000-0000-4000-8000-000000000002";
const state: FoodDayState = {
  foodDay: {
    id: foodDayId,
    localDate: "2026-10-19",
    status: "OPEN",
    completeness: "PARTIAL",
    targets: { calories: "2000", protein: "100" },
  },
  totals: {
    confirmed: { calories: "100", protein: "10", hasUnknownProtein: false },
  },
  targetProgress: {
    calories: { remainingToTarget: "1900", overTargetBy: "0" },
    protein: { remainingToTarget: "90", overTargetBy: "0" },
  },
  entries: [
    {
      id: entryId,
      displayName: "Oats",
      rawUserDescription: "oats",
      quantity: { amount: "1", unit: "SERVING" },
      status: "CONFIRMED_CONSUMED",
      workingNutrition: { calories: "100", protein: "10" },
      evidenceClass: "EXACT",
      revision: 3,
    },
  ],
};
const make = (calls: readonly unknown[]) =>
  createFoodDayExecutionPlan({
    decision: { type: "TOOLS", calls },
    state,
    userMessage: "I weighed 80 kg today and want my latest weight.",
    calendarContext: { currentLocalDate: "2026-10-19" },
  });

describe("durable FoodDay planning value", () => {
  it("stores exact accepted direct response in one versioned target-bound slot", () => {
    const plan = createFoodDayExecutionPlan({
      decision: { type: "FINAL", text: "  Hello.  " },
      state,
      userMessage: "Hi",
    });
    expect(plan).toEqual({
      schema: "account-turn-plan-v1",
      foodDayId,
      slots: [
        {
          index: 0,
          action: "DIRECT_RESPONSE",
          command: { response: "Hello." },
        },
      ],
    });
    expect(
      parseFoodDayExecutionPlan(JSON.parse(JSON.stringify(plan)), foodDayId),
    ).toEqual(plan);
  });

  it("persists ordered canonical tools, revisions, completeness CAS and account read", () => {
    const plan = make([
      {
        name: "UPDATE_FOOD_QUANTITY",
        arguments: {
          entryId,
          expectedRevision: 3,
          quantity: { amount: "2.00", unit: "SERVING" },
          overrideAction: { type: "PRESERVE" },
        },
      },
      {
        name: "SET_FOOD_DAY_COMPLETENESS",
        arguments: { targetCompleteness: "USER_DECLARED_COMPLETE" },
      },
      {
        name: "LOG_BODY_WEIGHT",
        arguments: {
          localDate: "2026-10-19",
          sourceValue: "80",
          sourceUnit: "KG",
        },
      },
      { name: "GET_BODY_WEIGHT_HISTORY", arguments: {} },
    ]);
    expect(plan.slots.map((slot) => [slot.index, slot.action])).toEqual([
      [0, "UPDATE_FOOD_QUANTITY"],
      [1, "SET_FOOD_DAY_COMPLETENESS"],
      [2, "LOG_BODY_WEIGHT"],
      [3, "GET_BODY_WEIGHT_HISTORY"],
    ]);
    expect(plan.slots[0]?.command).toMatchObject({
      entryId,
      expectedRevision: 3,
      quantity: { amount: "2", unit: "SERVING" },
    });
    expect(plan.slots[1]?.command).toEqual({
      targetCompleteness: "USER_DECLARED_COMPLETE",
      expectedCompleteness: "PARTIAL",
    });
    expect(plan.slots[2]?.command).not.toHaveProperty("foodDayId");
    expect(parseFoodDayExecutionPlan(plan, foodDayId)).toEqual(plan);
  });

  it("binds a new food log to the trusted day and freezes normalized domain values", () => {
    const plan = make([
      {
        name: "LOG_FOOD",
        arguments: {
          rawUserDescription: "  An apple  ",
          displayName: "  Apple  ",
          quantity: { amount: "1.00", unit: "SERVING" },
          nutritionBasis: {
            amount: "1",
            unit: "SERVING",
            nutrition: { calories: "95.00" },
          },
          evidenceClass: "EXACT",
        },
      },
    ]);
    expect(plan.foodDayId).toBe(foodDayId);
    expect(plan.slots[0]?.command).toMatchObject({
      rawUserDescription: "An apple",
      displayName: "Apple",
      quantity: { amount: "1", unit: "SERVING" },
      nutritionBasis: { nutrition: { calories: "95" } },
      status: "CONFIRMED_CONSUMED",
    });
    expect(plan.slots[0]?.command).not.toHaveProperty("foodDayId");
  });

  it("rejects out-of-day, missing or stale entry preconditions", () => {
    for (const [id, revision] of [
      [otherEntryId, 3],
      [entryId, 4],
    ] as const) {
      expect(() =>
        make([
          {
            name: "REMOVE_FOOD",
            arguments: { entryId: id, expectedRevision: revision },
          },
        ]),
      ).toThrow();
    }
  });

  it.each([
    ["REMOVE_FOOD", { entryId, expectedRevision: 3 }],
    ["CHANGE_FOOD_STATUS", { entryId, expectedRevision: 3, status: "PLANNED" }],
  ] as const)(
    "accepts a canonical %s step at the planning revision",
    (name, args) => {
      expect(make([{ name, arguments: args }]).slots[0]).toMatchObject({
        index: 0,
        action: name,
        command: args,
      });
    },
  );

  it("rejects plans that self-conflict on one entry or completeness value", () => {
    expect(() =>
      make([
        { name: "REMOVE_FOOD", arguments: { entryId, expectedRevision: 3 } },
        { name: "REMOVE_FOOD", arguments: { entryId, expectedRevision: 3 } },
      ]),
    ).toThrow();
    expect(() =>
      make([
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          arguments: { targetCompleteness: "PARTIAL" },
        },
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          arguments: { targetCompleteness: "USER_DECLARED_COMPLETE" },
        },
      ]),
    ).toThrow();
  });

  it("rejects known domain no-ops before a plan is persisted", () => {
    expect(() =>
      make([
        {
          name: "CHANGE_FOOD_STATUS",
          arguments: {
            entryId,
            expectedRevision: 3,
            status: "CONFIRMED_CONSUMED",
          },
        },
      ]),
    ).toThrow();
    expect(() =>
      make([
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          arguments: {
            targetCompleteness: "PARTIAL",
          },
        },
      ]),
    ).toThrow();
  });

  it("rejects malformed provider tools and unsupported weight evidence before persistence", () => {
    expect(() => make([{ name: "DO_ANYTHING", arguments: {} }])).toThrow();
    expect(() =>
      make([{ name: "LOG_FOOD", arguments: { userId: "other" } }]),
    ).toThrow();
    expect(() =>
      createFoodDayExecutionPlan({
        decision: {
          type: "TOOLS",
          calls: [
            {
              name: "LOG_BODY_WEIGHT",
              arguments: {
                localDate: "2026-10-18",
                sourceValue: "80",
                sourceUnit: "KG",
              },
            },
          ],
        },
        state,
        userMessage: "I weighed 80 kg today.",
        calendarContext: { currentLocalDate: "2026-10-19" },
      }),
    ).toThrow();
    expect(() =>
      make(
        Array.from({ length: 9 }, () => ({
          name: "GET_BODY_WEIGHT_HISTORY",
          arguments: {},
        })),
      ),
    ).toThrow();
    expect(() =>
      createFoodDayExecutionPlan({
        decision: {
          type: "TOOLS",
          calls: [
            {
              name: "LOG_BODY_WEIGHT",
              arguments: {
                localDate: "2026-02-30",
                sourceValue: "80",
                sourceUnit: "KG",
              },
            },
          ],
        },
        state,
        userMessage: "I weighed 80 kg on 2026-02-30.",
      }),
    ).toThrow();
  });

  it("strictly rejects corrupt persisted variants, target substitution and ordinals", () => {
    const direct = createFoodDayExecutionPlan({
      decision: { type: "FINAL", text: "Hello." },
      state,
      userMessage: "Hi",
    });
    for (const bad of [
      { ...direct, foodDayId: otherEntryId },
      { ...direct, slots: [{ ...direct.slots[0], index: 1 }] },
      {
        ...direct,
        slots: [{ ...direct.slots[0], command: { response: "  " } }],
      },
      { ...direct, slots: [...direct.slots, ...direct.slots] },
      { ...direct, schema: "account-turn-plan-v2" },
    ])
      expect(() => parseFoodDayExecutionPlan(bad, foodDayId)).toThrow();
    const remove = make([
      { name: "REMOVE_FOOD", arguments: { entryId, expectedRevision: 3 } },
    ]);
    for (const bad of [
      {
        ...remove,
        slots: [
          {
            index: 0,
            action: "REMOVE_FOOD",
            command: { entryId, expectedRevision: 0 },
          },
        ],
      },
      {
        ...remove,
        slots: [
          {
            index: 0,
            action: "REMOVE_FOOD",
            command: { entryId, expectedRevision: 3, userId: "other" },
          },
        ],
      },
      { ...remove, slots: [{ index: 0, action: "UNKNOWN", command: {} }] },
      { ...remove, slots: [remove.slots[0], { ...remove.slots[0], index: 1 }] },
    ])
      expect(() => parseFoodDayExecutionPlan(bad, foodDayId)).toThrow();
  });
});
