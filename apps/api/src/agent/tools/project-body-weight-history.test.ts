import { describe, expect, it } from "vitest";

import type { GetBodyWeightHistoryResult } from "../../queries/get-body-weight-history.js";
import {
  BODY_WEIGHT_AGENT_LATEST_DATE_OBSERVATION_LIMIT,
  projectBodyWeightHistory,
} from "./project-body-weight-history.js";

const observation = {
  id: "20000000-0000-4000-8000-000000000001",
  localDate: "2026-10-05",
  sourceValue: "178.125",
  sourceUnit: "LB" as const,
  weightKg: "80.79614090625",
  createdAt: "2026-10-07T12:00:00Z",
};

function history(
  recentObservations: GetBodyWeightHistoryResult["recentObservations"],
  latestDateObservations: GetBodyWeightHistoryResult["latestDateObservations"],
): GetBodyWeightHistoryResult {
  return {
    recentObservations,
    latestMeasurementDate: latestDateObservations[0]?.localDate ?? null,
    latestDateObservations,
  };
}

describe("projectBodyWeightHistory", () => {
  it("projects empty canonical history without false truncation", () => {
    expect(projectBodyWeightHistory(history([], []))).toEqual({
      recentObservations: [],
      recentHistoryMayBeTruncated: false,
      latestMeasurementDate: null,
      latestDateObservationCount: 0,
      latestDateObservations: [],
      latestDateObservationsComplete: true,
    });
  });

  it("keeps exact source and kg strings but removes IDs and ingestion timestamps", () => {
    const result = projectBodyWeightHistory(
      history([observation], [observation]),
    );
    const projected = {
      localDate: "2026-10-05",
      sourceValue: "178.125",
      sourceUnit: "LB",
      weightKg: "80.79614090625",
    };
    expect(result).toEqual({
      recentObservations: [projected],
      recentHistoryMayBeTruncated: false,
      latestMeasurementDate: "2026-10-05",
      latestDateObservationCount: 1,
      latestDateObservations: [projected],
      latestDateObservationsComplete: true,
    });
    expect(JSON.stringify(result)).not.toContain(observation.id);
    expect(JSON.stringify(result)).not.toContain(observation.createdAt);
    expect(typeof result.latestDateObservations[0]?.weightKg).toBe("string");
  });

  it("conservatively flags a full recent window without an extra count query", () => {
    const thirty = Array.from({ length: 30 }, (_, index) => ({
      ...observation,
      id: `observation-${index}`,
    }));
    expect(
      projectBodyWeightHistory(history(thirty.slice(0, 29), thirty)),
    ).toMatchObject({ recentHistoryMayBeTruncated: false });
    expect(projectBodyWeightHistory(history(thirty, thirty))).toMatchObject({
      recentHistoryMayBeTruncated: true,
    });
  });

  it("caps only the model-facing latest-date list while retaining its full count", () => {
    const thirtyOne = Array.from({ length: 31 }, (_, index) => ({
      ...observation,
      id: `observation-${index}`,
      sourceValue: `178.${index}`,
    }));
    const result = projectBodyWeightHistory(
      history(thirtyOne.slice(0, 30), thirtyOne),
    );
    expect(BODY_WEIGHT_AGENT_LATEST_DATE_OBSERVATION_LIMIT).toBe(30);
    expect(result.recentObservations).toHaveLength(30);
    expect(result.latestDateObservationCount).toBe(31);
    expect(result.latestDateObservations).toHaveLength(30);
    expect(result.latestDateObservationsComplete).toBe(false);
    expect(result.latestDateObservations[0]?.sourceValue).toBe("178.0");
    expect(result.latestDateObservations[29]?.sourceValue).toBe("178.29");
  });

  it("preserves multiplicity even when projected observations are identical", () => {
    const duplicate = { ...observation, id: "different-id" };
    const result = projectBodyWeightHistory(
      history([observation, duplicate], [observation, duplicate]),
    );
    expect(result.latestDateObservationCount).toBe(2);
    expect(result.latestDateObservations).toHaveLength(2);
    expect(result.latestDateObservations[0]).toEqual(
      result.latestDateObservations[1],
    );
  });
});
