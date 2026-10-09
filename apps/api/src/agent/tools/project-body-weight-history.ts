import {
  BODY_WEIGHT_RECENT_HISTORY_LIMIT,
  type BodyWeightHistoryObservation,
  type GetBodyWeightHistoryResult,
} from "../../queries/get-body-weight-history.js";

export const BODY_WEIGHT_AGENT_LATEST_DATE_OBSERVATION_LIMIT = 30;

export interface ModelBodyWeightObservation {
  readonly localDate: string;
  readonly sourceValue: string;
  readonly sourceUnit: "KG" | "LB";
  readonly weightKg: string;
}

export interface ModelBodyWeightHistory {
  readonly recentObservations: readonly ModelBodyWeightObservation[];
  readonly recentHistoryMayBeTruncated: boolean;
  readonly latestMeasurementDate: string | null;
  readonly latestDateObservationCount: number;
  readonly latestDateObservations: readonly ModelBodyWeightObservation[];
  readonly latestDateObservationsComplete: boolean;
}

/** Bound the model payload without changing the complete canonical read. */
export function projectBodyWeightHistory(
  history: GetBodyWeightHistoryResult,
): ModelBodyWeightHistory {
  const latestDateObservationCount = history.latestDateObservations.length;
  return {
    recentObservations: history.recentObservations.map(toModelObservation),
    recentHistoryMayBeTruncated:
      history.recentObservations.length === BODY_WEIGHT_RECENT_HISTORY_LIMIT,
    latestMeasurementDate: history.latestMeasurementDate,
    latestDateObservationCount,
    latestDateObservations: history.latestDateObservations
      .slice(0, BODY_WEIGHT_AGENT_LATEST_DATE_OBSERVATION_LIMIT)
      .map(toModelObservation),
    latestDateObservationsComplete:
      latestDateObservationCount <=
      BODY_WEIGHT_AGENT_LATEST_DATE_OBSERVATION_LIMIT,
  };
}

function toModelObservation(
  observation: BodyWeightHistoryObservation,
): ModelBodyWeightObservation {
  return {
    localDate: observation.localDate,
    sourceValue: observation.sourceValue,
    sourceUnit: observation.sourceUnit,
    weightKg: observation.weightKg,
  };
}
