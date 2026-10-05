import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import type { FoodDayCompleteness } from "@cal-calc/persistence";
import OpenAI from "openai";
import { it } from "vitest";

import { createOpenAIFoodDayTurnModel } from "../agent/providers/openai/openai-food-day-turn-model.js";
import type { FoodDayToolResult } from "../agent/tools/execute-food-day-tool.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import {
  buildFoodDayState,
  type FoodDayState,
} from "../state/build-food-day-state.js";
import {
  hasAffirmativeCalorieTargetDirection,
  hasAffirmativeForbiddenPhysiology,
  hasAffirmativeNonzeroTargetDirectionClaim,
  hasAffirmativePostMutationCalorieProgress,
  hasAffirmativeProteinTargetProgress,
  hasExactCanonicalAmount,
  hasExactTargetEqualitySemantics,
  hasIncompleteProgressQualifier,
  hasWholeDayOverclaim,
} from "./target-progress-eval-assertions.js";

interface EntryFixture {
  readonly name: string;
  readonly calories: string;
  readonly protein?: string;
  readonly status?: "CONFIRMED_CONSUMED" | "PLANNED";
}

interface StateFixture {
  readonly id: number;
  readonly completeness: FoodDayCompleteness;
  readonly calorieTarget: string;
  readonly entries: readonly EntryFixture[];
}

type DirectExpectation =
  | "INCOMPLETE_REMAINING"
  | "COMPLETE_REMAINING"
  | "INCOMPLETE_OVER"
  | "COMPLETE_EQUAL"
  | "UNKNOWN_PROTEIN";

interface DirectScenario extends StateFixture {
  readonly name: string;
  readonly message: string;
  readonly expected: DirectExpectation;
  readonly expectedAmount?: string;
}

const directScenarios: readonly DirectScenario[] = [
  {
    name: "incomplete day uses canonical calories remaining and qualifies the log",
    id: 1,
    completeness: "PARTIAL",
    calorieTarget: "2000.125",
    entries: [
      { name: "Breakfast", calories: "1375", protein: "35" },
      { name: "Planned dinner", calories: "500", status: "PLANNED" },
    ],
    message: "How many calories do I have left?",
    expected: "INCOMPLETE_REMAINING",
    expectedAmount: "625.125",
  },
  {
    name: "declared-complete day permits a direct target comparison",
    id: 2,
    completeness: "USER_DECLARED_COMPLETE",
    calorieTarget: "2050.5",
    entries: [{ name: "Meals", calories: "1700", protein: "75" }],
    message: "How did I finish against my calorie target?",
    expected: "COMPLETE_REMAINING",
    expectedAmount: "350.5",
  },
  {
    name: "incomplete over-target day remains qualified and open",
    id: 3,
    completeness: "UNKNOWN",
    calorieTarget: "1800",
    entries: [{ name: "Meals", calories: "1917.25", protein: "80" }],
    message: "How am I doing against my calorie target?",
    expected: "INCOMPLETE_OVER",
    expectedAmount: "117.25",
  },
  {
    name: "declared-complete exact target is equality, not zero intake",
    id: 4,
    completeness: "USER_DECLARED_COMPLETE",
    calorieTarget: "2000",
    entries: [{ name: "Meals", calories: "2000", protein: "80" }],
    message: "How did I finish versus my calorie target?",
    expected: "COMPLETE_EQUAL",
  },
  {
    name: "unknown confirmed protein cannot become exact target progress",
    id: 5,
    completeness: "PARTIAL",
    calorieTarget: "2200",
    entries: [
      { name: "Yogurt", calories: "400", protein: "30" },
      { name: "Soup", calories: "250" },
    ],
    message: "How much protein do I have left?",
    expected: "UNKNOWN_PROTEIN",
  },
];

const staleFixture: StateFixture = {
  id: 6,
  completeness: "PARTIAL",
  calorieTarget: "2100.375",
  entries: [{ name: "Earlier meals", calories: "1487", protein: "65" }],
};

function stateFor(fixture: StateFixture): FoodDayState {
  const suffix = String(fixture.id).padStart(12, "0");
  const foodDay = createFoodDay({
    id: `10000000-0000-4000-8000-${suffix}`,
    status: "OPEN",
    calorieTarget: fixture.calorieTarget,
    proteinTarget: "120",
  });
  const entries = fixture.entries.map((entry, index) =>
    createFoodEntry({
      id: `20000000-0000-4000-8000-${String(fixture.id * 100 + index).padStart(12, "0")}`,
      foodDayId: foodDay.id,
      rawUserDescription: `I had ${entry.name.toLowerCase()}.`,
      displayName: entry.name,
      quantity: { amount: "1", unit: "SERVING" },
      nutritionBasis: {
        amount: "1",
        unit: "SERVING",
        nutrition: {
          calories: entry.calories,
          ...(entry.protein === undefined ? {} : { protein: entry.protein }),
        },
      },
      evidenceClass: "EXACT",
      status: entry.status ?? "CONFIRMED_CONSUMED",
    }),
  );
  return buildFoodDayState({
    foodDay,
    entries,
    completeness: fixture.completeness,
    localDate: "2026-10-05",
  });
}

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for the live target-progress eval.`);
  return value;
}

function modelForEval() {
  const apiKey = requiredEnvironment("OPENAI_API_KEY");
  const modelName = requiredEnvironment("OPENAI_MODEL");
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
  return createOpenAIFoodDayTurnModel({ client, model: modelName });
}

class EvalMismatch extends Error {
  override readonly name = "EvalMismatch";
}

function orderedToolNames(calls: readonly unknown[]): string[] {
  return calls.map((call) => {
    try {
      return parseFoodDayToolCall(call).name;
    } catch {
      return "INVALID_TOOL_CALL";
    }
  });
}

it.each(directScenarios)(
  "$name",
  async (scenario) => {
    const state = stateFor(scenario);
    const canonicalAmount =
      scenario.expected === "INCOMPLETE_OVER"
        ? state.targetProgress.calories.overTargetBy
        : state.targetProgress.calories.remainingToTarget;
    if (
      (scenario.expectedAmount !== undefined &&
        canonicalAmount !== scenario.expectedAmount) ||
      (scenario.expected === "INCOMPLETE_REMAINING" &&
        state.targetProgress.calories.overTargetBy !== "0") ||
      (scenario.expected === "INCOMPLETE_OVER" &&
        state.targetProgress.calories.remainingToTarget !== "0") ||
      (scenario.expected === "COMPLETE_EQUAL" &&
        (canonicalAmount !== "0" ||
          state.targetProgress.calories.overTargetBy !== "0")) ||
      (scenario.expected === "UNKNOWN_PROTEIN" &&
        (state.totals.confirmed.protein !== null ||
          state.targetProgress.protein.remainingToTarget !== null ||
          state.targetProgress.protein.overTargetBy !== null))
    ) {
      throw new Error(`${scenario.name}: invalid canonical STATE fixture.`);
    }
    const expectedProgress =
      scenario.expected === "UNKNOWN_PROTEIN"
        ? state.targetProgress.protein
        : state.targetProgress.calories;
    let actual: Record<string, unknown> = {
      expectedDecisionKind: "FINAL",
      actualDecisionKind: "NO_DECISION",
      orderedToolNames: [],
      completeness: state.foodDay.completeness,
      targetProgress: expectedProgress,
    };

    try {
      // One paid decision request; no finalize, backend mutation, or retry.
      const model = modelForEval();
      const decision = await model.decide({
        state,
        recentTranscript: [],
        userMessage: scenario.message,
      });
      const calls = decision.type === "TOOLS" ? decision.calls : [];
      actual = {
        ...actual,
        actualDecisionKind: decision.type,
        orderedToolNames: orderedToolNames(calls),
      };
      if (decision.type !== "FINAL" || calls.length !== 0) {
        throw new EvalMismatch("expected a direct answer with zero tools");
      }

      const text = decision.text;
      const responseExcerpt = text.slice(0, 240);
      const expectedAmountPresent =
        scenario.expected === "UNKNOWN_PROTEIN" ||
        scenario.expected === "COMPLETE_EQUAL" ||
        hasExactCanonicalAmount(text, canonicalAmount);
      const qualifierDetected =
        scenario.expectedAmount !== undefined &&
        hasIncompleteProgressQualifier(text, canonicalAmount);
      const forbiddenTerminologyDetected =
        hasAffirmativeForbiddenPhysiology(text);
      const wholeDayClaimDetected = hasWholeDayOverclaim(text);
      const equalityDetected = hasExactTargetEqualitySemantics(text);
      const contradictoryDirectionDetected =
        scenario.expected === "COMPLETE_EQUAL" &&
        hasAffirmativeNonzeroTargetDirectionClaim(text);
      const underTargetDetected = hasAffirmativeCalorieTargetDirection(
        text,
        "UNDER",
      );
      const overTargetDetected = hasAffirmativeCalorieTargetDirection(
        text,
        "OVER",
      );
      const proteinUnknownDetected =
        /\bprotein\b/i.test(text) &&
        /\b(?:unknown|cannot|can't|unable|not enough|insufficient|unavailable|uncertain|don't know)\b/i.test(
          text,
        );
      const proteinTargetClaimDetected =
        hasAffirmativeProteinTargetProgress(text);
      actual = {
        ...actual,
        expectedAmountPresent,
        qualifierDetected,
        forbiddenTerminologyDetected,
        wholeDayClaimDetected,
        equalityDetected,
        contradictoryDirectionDetected,
        underTargetDetected,
        overTargetDetected,
        proteinUnknownDetected,
        proteinTargetClaimDetected,
        responseExcerpt,
      };

      if (forbiddenTerminologyDetected) {
        throw new EvalMismatch("physiological target interpretation");
      }
      switch (scenario.expected) {
        case "INCOMPLETE_REMAINING":
          if (
            !expectedAmountPresent ||
            !qualifierDetected ||
            !underTargetDetected ||
            overTargetDetected ||
            wholeDayClaimDetected
          ) {
            throw new EvalMismatch("incomplete remaining semantics differed");
          }
          break;
        case "COMPLETE_REMAINING":
          if (
            !expectedAmountPresent ||
            !underTargetDetected ||
            overTargetDetected
          ) {
            throw new EvalMismatch("complete remaining semantics differed");
          }
          break;
        case "INCOMPLETE_OVER":
          if (
            !expectedAmountPresent ||
            !qualifierDetected ||
            !overTargetDetected ||
            underTargetDetected ||
            wholeDayClaimDetected
          ) {
            throw new EvalMismatch("incomplete over-target semantics differed");
          }
          break;
        case "COMPLETE_EQUAL":
          if (
            !equalityDetected ||
            contradictoryDirectionDetected ||
            /\b(?:consumed|ate|logged)\s+0\s+(?:calories|kcal)\b/i.test(text)
          ) {
            throw new EvalMismatch("exact-target semantics differed");
          }
          break;
        case "UNKNOWN_PROTEIN":
          if (!proteinUnknownDetected || proteinTargetClaimDetected) {
            throw new EvalMismatch("unknown-protein semantics differed");
          }
          break;
      }
    } catch (error) {
      // SDK errors may contain request data; report only their class/name.
      const failure =
        error instanceof EvalMismatch
          ? error.message
          : error instanceof Error
            ? error.name
            : "UnknownError";
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${scenario.name}: ${JSON.stringify({ ...actual, failure })}`,
      );
    }
  },
  45_000,
);

it("food logging does not turn pre-mutation progress into a current answer", async () => {
  const state = stateFor(staleFixture);
  const userMessage =
    "Log an apple I just ate, and how many calories do I have left now?";
  const staleRemaining = state.targetProgress.calories.remainingToTarget;
  if (staleRemaining !== "613.375") {
    throw new Error(
      "food mutation staleness: invalid canonical STATE fixture.",
    );
  }
  let actual: Record<string, unknown> = {
    expectedDecisionKind: "TOOLS",
    actualDecisionKind: "NO_DECISION",
    orderedToolNames: [],
    completeness: state.foodDay.completeness,
    targetProgress: state.targetProgress.calories,
    staleAmountAppeared: false,
    unsupportedCurrentProgressDetected: false,
    forbiddenTerminologyDetected: false,
  };

  try {
    // One paid decision request, then one paid finalization request; no executor.
    const model = modelForEval();
    const decision = await model.decide({
      state,
      recentTranscript: [],
      userMessage,
    });
    const calls = decision.type === "TOOLS" ? decision.calls : [];
    actual = {
      ...actual,
      actualDecisionKind: decision.type,
      orderedToolNames: orderedToolNames(calls),
    };
    if (decision.type !== "TOOLS" || calls.length !== 1) {
      throw new EvalMismatch("expected exactly one LOG_FOOD call");
    }
    const call = parseFoodDayToolCall(calls[0]);
    if (
      call.name !== "LOG_FOOD" ||
      (call.arguments.status ?? "CONFIRMED_CONSUMED") !==
        "CONFIRMED_CONSUMED" ||
      !/apple/i.test(
        `${call.arguments.displayName} ${call.arguments.rawUserDescription}`,
      )
    ) {
      throw new EvalMismatch(
        "expected confirmed apple logging without other tools",
      );
    }

    const entry = createFoodEntry({
      id: "30000000-0000-4000-8000-000000000006",
      foodDayId: state.foodDay.id,
      ...call.arguments,
      status: "CONFIRMED_CONSUMED",
    });
    const toolResults: readonly FoodDayToolResult[] = [
      { name: "LOG_FOOD", result: { disposition: "CREATED", entry } },
    ];
    const text = await model.finalize({
      state,
      recentTranscript: [],
      userMessage,
      toolResults,
    });
    const staleAmountAppeared = hasExactCanonicalAmount(text, staleRemaining);
    const unsupportedCurrentProgressDetected =
      hasAffirmativePostMutationCalorieProgress(text);
    const forbiddenTerminologyDetected =
      hasAffirmativeForbiddenPhysiology(text);
    actual = {
      ...actual,
      staleAmountAppeared,
      unsupportedCurrentProgressDetected,
      forbiddenTerminologyDetected,
    };
    if (unsupportedCurrentProgressDetected || forbiddenTerminologyDetected) {
      throw new EvalMismatch(
        "final answer asserted unsupported current target progress",
      );
    }
  } catch (error) {
    const failure =
      error instanceof EvalMismatch
        ? error.message
        : error instanceof Error
          ? error.name
          : "UnknownError";
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `food mutation staleness: ${JSON.stringify({ ...actual, failure })}`,
    );
  }
}, 75_000);
