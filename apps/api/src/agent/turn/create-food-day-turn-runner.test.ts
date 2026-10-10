import type {
  PostgresExecutor,
  PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseIdempotencyKey } from "../../mutations/mutation-identity.js";
import { getBodyWeightHistory } from "../../queries/get-body-weight-history.js";
import type { FoodDayState } from "../../state/build-food-day-state.js";
import {
  createFoodDayTurnRunner,
  RECENT_FOOD_DAY_TRANSCRIPT_LIMIT,
} from "./create-food-day-turn-runner.js";
import type { FoodDayTurnInput } from "./food-day-turn-types.js";
import { runDurableFoodDayTurn } from "./run-durable-food-day-turn.js";
import { runFoodDayTurn } from "./run-food-day-turn.js";

vi.mock("./run-durable-food-day-turn.js", () => ({
  runDurableFoodDayTurn: vi.fn(),
}));
vi.mock("./run-food-day-turn.js", () => ({ runFoodDayTurn: vi.fn() }));

const durableRunner = vi.mocked(runDurableFoodDayTurn);
const turnRunner = vi.mocked(runFoodDayTurn);
const input: FoodDayTurnInput = {
  trustedUserId: "10000000-0000-4000-8000-000000000001",
  foodDayId: "20000000-0000-4000-8000-000000000001",
  turnIdempotencyKey: parseIdempotencyKey("trusted-turn-key"),
  userMessage: "Continue.",
};
const state = {} as FoodDayState;

describe("createFoodDayTurnRunner transcript composition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    durableRunner.mockImplementation(async (dependencies, turnInput) => ({
      response: (await dependencies.runTurn(turnInput)).response,
    }));
  });

  it("loads eight recent pairs for the trusted user and FoodDay", async () => {
    const query = vi.fn<PostgresExecutor["query"]>();
    query.mockResolvedValue({
      rows: [
        { user_message: "Earlier message.", response: "Earlier response." },
      ],
    });
    const postgres: PostgresExecutor = { query };
    const transactionRunner = {} as PostgresTransactionRunner;
    let loadedTranscript: unknown;
    turnRunner.mockImplementation(async (dependencies, turnInput) => {
      loadedTranscript = await dependencies.loadRecentTranscript({
        trustedUserId: turnInput.trustedUserId,
        foodDayId: turnInput.foodDayId,
      });
      return { response: "Done.", state, toolResults: [] };
    });

    const runTurn = createFoodDayTurnRunner({
      postgres,
      transactionRunner,
      model: { decide: vi.fn(), finalizeOrRead: vi.fn(), finalize: vi.fn() },
    });
    await expect(runTurn(input)).resolves.toEqual({ response: "Done." });

    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("from public.food_day_turn_results"),
      [input.trustedUserId, input.foodDayId, RECENT_FOOD_DAY_TRANSCRIPT_LIMIT],
    );
    expect(RECENT_FOOD_DAY_TRANSCRIPT_LIMIT).toBe(8);
    expect(loadedTranscript).toEqual([
      { userMessage: "Earlier message.", response: "Earlier response." },
    ]);
  });

  it("wires the committed body-weight application query to the caller-owned PostgreSQL executor", async () => {
    const query = vi.fn<PostgresExecutor["query"]>().mockResolvedValue({
      rows: [],
    });
    const postgres: PostgresExecutor = { query };
    turnRunner.mockImplementation(async (dependencies, turnInput) => {
      expect(
        await getBodyWeightHistory(dependencies, {
          trustedUserId: turnInput.trustedUserId,
        }),
      ).toEqual({
        recentObservations: [],
        latestMeasurementDate: null,
        latestDateObservations: [],
      });
      return { response: "No observations.", state, toolResults: [] };
    });

    const runTurn = createFoodDayTurnRunner({
      postgres,
      transactionRunner: {} as PostgresTransactionRunner,
      model: { decide: vi.fn(), finalizeOrRead: vi.fn(), finalize: vi.fn() },
    });
    await expect(runTurn(input)).resolves.toEqual({
      response: "No observations.",
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("from public.body_weight_entries"),
      [input.trustedUserId, 30],
    );
  });
});
