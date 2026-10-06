import {
  createBodyWeightEntry,
  normalizeDecimal,
  type BodyWeightEntry,
} from "@cal-calc/domain";

import type { BodyWeightEntryRow, PersistedBodyWeightEntry } from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

export interface CreateBodyWeightRecord {
  readonly userId: string;
  readonly entry: BodyWeightEntry;
}

export class PostgresBodyWeightRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async create(
    input: CreateBodyWeightRecord,
  ): Promise<PersistedBodyWeightEntry> {
    const result = await this.executor.query(
      `insert into public.body_weight_entries (
         id, user_id, local_date, source_value, source_unit, weight_kg
       ) values ($1, $2, $3::date, $4::numeric, $5::public.body_weight_unit, $6::numeric)
       returning ${resultColumns}`,
      [
        input.entry.id,
        input.userId,
        input.entry.localDate,
        input.entry.sourceValue,
        input.entry.sourceUnit,
        input.entry.weightKg,
      ],
    );
    if (result.rows[0] === undefined) {
      throw new Error(
        "PostgreSQL returned no body-weight observation after insert.",
      );
    }
    return fromRow(result.rows[0]);
  }

  async findById(
    userId: string,
    entryId: string,
  ): Promise<PersistedBodyWeightEntry | null> {
    const result = await this.executor.query(
      `select ${resultColumns}
       from public.body_weight_entries
       where id = $1 and user_id = $2`,
      [entryId, userId],
    );
    return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
  }
}

const resultColumns = `
  id,
  user_id,
  local_date::text as local_date,
  source_value::text as source_value,
  source_unit,
  weight_kg::text as weight_kg,
  to_jsonb(created_at) #>> '{}' as created_at
`;

function fromRow(value: unknown): PersistedBodyWeightEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PostgreSQL returned an invalid body-weight row.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.user_id !== "string" ||
    typeof row.local_date !== "string" ||
    typeof row.source_value !== "string" ||
    typeof row.weight_kg !== "string" ||
    typeof row.created_at !== "string" ||
    (row.source_unit !== "KG" && row.source_unit !== "LB")
  ) {
    throw new TypeError("PostgreSQL returned an invalid body-weight row.");
  }
  const typed = row as unknown as BodyWeightEntryRow;
  const entry = createBodyWeightEntry({
    id: typed.id,
    localDate: typed.local_date,
    sourceValue: typed.source_value,
    sourceUnit: typed.source_unit,
  });
  if (entry.weightKg !== normalizeDecimal(typed.weight_kg)) {
    throw new TypeError(
      "PostgreSQL returned inconsistent body-weight conversion.",
    );
  }
  return { entry, userId: typed.user_id, createdAt: typed.created_at };
}
