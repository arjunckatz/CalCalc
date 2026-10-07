import type { BodyWeightEntry } from "@cal-calc/domain";
import type {
  PersistedBodyWeightEntry,
  PostgresBodyWeightRepository,
} from "@cal-calc/persistence";

export const BODY_WEIGHT_RECENT_HISTORY_LIMIT = 30;

export interface BodyWeightHistoryObservation extends BodyWeightEntry {
  /** Ingestion timestamp, not necessarily the time of measurement. */
  readonly createdAt: string;
}

export interface GetBodyWeightHistoryResult {
  readonly recentObservations: readonly BodyWeightHistoryObservation[];
  readonly latestMeasurementDate: string | null;
  readonly latestDateObservations: readonly BodyWeightHistoryObservation[];
}

export interface GetBodyWeightHistoryDependencies {
  readonly bodyWeights: Pick<PostgresBodyWeightRepository, "readHistory">;
}

export interface GetBodyWeightHistoryInput {
  readonly trustedUserId: string;
}

export async function getBodyWeightHistory(
  dependencies: GetBodyWeightHistoryDependencies,
  input: GetBodyWeightHistoryInput,
): Promise<GetBodyWeightHistoryResult> {
  const history = await dependencies.bodyWeights.readHistory(
    input.trustedUserId,
    BODY_WEIGHT_RECENT_HISTORY_LIMIT,
  );
  return {
    recentObservations: history.recentObservations.map(toObservation),
    latestMeasurementDate: history.latestMeasurementDate,
    latestDateObservations: history.latestDateObservations.map(toObservation),
  };
}

function toObservation(
  persisted: PersistedBodyWeightEntry,
): BodyWeightHistoryObservation {
  return { ...persisted.entry, createdAt: persisted.createdAt };
}
