import { createBodyWeightEntry } from "@cal-calc/domain";
import { describe, expect, it, vi } from "vitest";

import {
  BODY_WEIGHT_RECENT_HISTORY_LIMIT,
  getBodyWeightHistory,
} from "./get-body-weight-history.js";

const trustedUserId = "10000000-0000-4000-8000-000000000001";
const entry = createBodyWeightEntry({
  id: "20000000-0000-4000-8000-000000000001",
  localDate: "2026-10-05",
  sourceValue: "180.25",
  sourceUnit: "LB",
});
const persisted = {
  entry,
  userId: trustedUserId,
  createdAt: "2026-10-07T10:00:00Z",
};

describe("getBodyWeightHistory", () => {
  it("passes only the trusted user and fixed bound to the read repository", async () => {
    const bodyWeights = {
      readHistory: vi.fn().mockResolvedValue({
        recentObservations: [persisted],
        latestMeasurementDate: "2026-10-05",
        latestDateObservations: [persisted],
      }),
    };
    const result = await getBodyWeightHistory(
      { bodyWeights },
      { trustedUserId },
    );
    expect(BODY_WEIGHT_RECENT_HISTORY_LIMIT).toBe(30);
    expect(bodyWeights.readHistory).toHaveBeenCalledExactlyOnceWith(
      trustedUserId,
      30,
    );
    expect(result).toEqual({
      recentObservations: [{ ...entry, createdAt: persisted.createdAt }],
      latestMeasurementDate: "2026-10-05",
      latestDateObservations: [{ ...entry, createdAt: persisted.createdAt }],
    });
    expect(result.recentObservations[0]).not.toHaveProperty("userId");
    expect(result.recentObservations[0]?.weightKg).toBe("81.7600246925");
  });

  it("returns a non-error empty history", async () => {
    const bodyWeights = {
      readHistory: vi.fn().mockResolvedValue({
        recentObservations: [],
        latestMeasurementDate: null,
        latestDateObservations: [],
      }),
    };
    await expect(
      getBodyWeightHistory({ bodyWeights }, { trustedUserId }),
    ).resolves.toEqual({
      recentObservations: [],
      latestMeasurementDate: null,
      latestDateObservations: [],
    });
  });

  it("preserves repository order and the independently complete latest-date set", async () => {
    const other = {
      ...persisted,
      entry: createBodyWeightEntry({
        id: "20000000-0000-4000-8000-000000000002",
        localDate: "2026-10-05",
        sourceValue: "80.2",
        sourceUnit: "KG",
      }),
    };
    const recent = Array.from({ length: 30 }, (_, index) => ({
      ...persisted,
      entry: { ...entry, id: `recent-${index}` },
    }));
    const bodyWeights = {
      readHistory: vi.fn().mockResolvedValue({
        recentObservations: recent,
        latestMeasurementDate: "2026-10-05",
        latestDateObservations: [...recent, other],
      }),
    };
    const result = await getBodyWeightHistory(
      { bodyWeights },
      { trustedUserId },
    );
    expect(result.recentObservations.map(({ id }) => id)).toEqual(
      recent.map(({ entry }) => entry.id),
    );
    expect(result.latestDateObservations).toHaveLength(31);
    expect(result.latestDateObservations[30]).toMatchObject({
      id: other.entry.id,
      sourceUnit: "KG",
      weightKg: "80.2",
    });
  });

  it("propagates unexpected repository failures without mutation infrastructure", async () => {
    const failure = new Error("Persistence read failed.");
    const bodyWeights = { readHistory: vi.fn().mockRejectedValue(failure) };
    await expect(
      getBodyWeightHistory({ bodyWeights }, { trustedUserId }),
    ).rejects.toBe(failure);
    expect(bodyWeights.readHistory).toHaveBeenCalledOnce();
  });
});
