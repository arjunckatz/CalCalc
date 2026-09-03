import { DomainValidationError, type FoodEntry } from "@cal-calc/domain";

import { fromFoodEntryRow, toFoodEntryWriteValues } from "../mapping.js";
import type {
  ConsumedTimePrecision,
  FoodEntryRow,
  PersistedFoodEntry,
} from "../types.js";

export interface PostgresExecutor {
  query(
    queryText: string,
    values?: unknown[],
  ): Promise<{ readonly rows: unknown[] }>;
}

export interface CreateFoodEntryRecord {
  readonly userId: string;
  readonly entry: FoodEntry;
  readonly consumedAt?: string;
  readonly consumedTimePrecision?: ConsumedTimePrecision;
}

export interface UpdateFoodEntryRecord {
  readonly userId: string;
  readonly expectedRevision: number;
  readonly entry: FoodEntry;
}

export class FoodEntryNotFoundError extends Error {
  override readonly name = "FoodEntryNotFoundError";

  constructor(readonly entryId: string) {
    super(`Food entry ${entryId} was not found for this user.`);
  }
}

export class FoodEntryRevisionConflictError extends Error {
  override readonly name = "FoodEntryRevisionConflictError";

  constructor(
    readonly entryId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Food entry ${entryId} revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`,
    );
  }
}

export class PostgresFoodEntryRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async create(input: CreateFoodEntryRecord): Promise<PersistedFoodEntry> {
    const values = toFoodEntryWriteValues(input.entry);
    const consumedTime = consumedTimeParameters(input);
    const result = await this.executor.query(
      `insert into public.food_entries (
         id,
         user_id,
         food_day_id,
         raw_user_description,
         display_name,
         normalized_name,
         brand,
         quantity_amount,
         quantity_unit,
         nutrition_basis_amount,
         nutrition_basis_unit,
         nutrition_basis,
         derived_nutrition,
         working_nutrition_override,
         working_nutrition,
         evidence_class,
         estimate_low,
         estimate_high,
         status,
         revision,
         deleted_at,
         consumed_at,
         consumed_time_precision
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
         $22, $23
       )
       returning ${foodEntryResultColumns}`,
      [...writeParameters(input.userId, values), ...consumedTime],
    );
    const row = firstRow<FoodEntryRow>(result.rows);
    if (row === undefined) {
      throw new Error("PostgreSQL returned no FoodEntry after insert.");
    }
    return fromFoodEntryRow(row);
  }

  async findById(
    userId: string,
    entryId: string,
  ): Promise<PersistedFoodEntry | null> {
    const result = await this.executor.query(
      `select ${foodEntryResultColumns}
       from public.food_entries
       where id = $1
         and user_id = $2`,
      [entryId, userId],
    );
    const row = firstRow<FoodEntryRow>(result.rows);
    return row === undefined ? null : fromFoodEntryRow(row);
  }

  async update(input: UpdateFoodEntryRecord): Promise<PersistedFoodEntry> {
    const values = toFoodEntryWriteValues(input.entry);
    const result = await this.executor.query(
      `update public.food_entries
       set food_day_id = $3,
           raw_user_description = $4,
           display_name = $5,
           normalized_name = $6,
           brand = $7,
           quantity_amount = $8,
           quantity_unit = $9,
           nutrition_basis_amount = $10,
           nutrition_basis_unit = $11,
           nutrition_basis = $12,
           derived_nutrition = $13,
           working_nutrition_override = $14,
           working_nutrition = $15,
           evidence_class = $16,
           estimate_low = $17,
           estimate_high = $18,
           status = $19,
           revision = $20,
           deleted_at = $21
       where id = $1
         and user_id = $2
         and revision = $22
       returning ${foodEntryResultColumns}`,
      [...writeParameters(input.userId, values), input.expectedRevision],
    );
    const row = firstRow<FoodEntryRow>(result.rows);
    if (row !== undefined) return fromFoodEntryRow(row);

    const current = await this.executor.query(
      `select revision
       from public.food_entries
       where id = $1
         and user_id = $2`,
      [input.entry.id, input.userId],
    );
    const revision = firstRow<{ readonly revision: number }>(current.rows);
    if (revision === undefined) {
      throw new FoodEntryNotFoundError(input.entry.id);
    }
    throw new FoodEntryRevisionConflictError(
      input.entry.id,
      input.expectedRevision,
      revision.revision,
    );
  }
}

const foodEntryResultColumns = `
  id,
  user_id,
  food_day_id,
  raw_user_description,
  display_name,
  normalized_name,
  brand,
  quantity_amount::text as quantity_amount,
  quantity_unit,
  nutrition_basis_amount::text as nutrition_basis_amount,
  nutrition_basis_unit,
  nutrition_basis,
  derived_nutrition,
  working_nutrition_override,
  working_nutrition,
  evidence_class,
  estimate_low,
  estimate_high,
  status,
  revision,
  to_jsonb(reported_at) #>> '{}' as reported_at,
  to_jsonb(consumed_at) #>> '{}' as consumed_at,
  consumed_time_precision,
  to_jsonb(deleted_at) #>> '{}' as deleted_at,
  last_operation_id,
  to_jsonb(created_at) #>> '{}' as created_at,
  to_jsonb(updated_at) #>> '{}' as updated_at
`;

function writeParameters(
  userId: string,
  values: ReturnType<typeof toFoodEntryWriteValues>,
): unknown[] {
  return [
    values.id,
    userId,
    values.food_day_id,
    values.raw_user_description,
    values.display_name,
    values.normalized_name,
    values.brand,
    values.quantity_amount,
    values.quantity_unit,
    values.nutrition_basis_amount,
    values.nutrition_basis_unit,
    values.nutrition_basis,
    values.derived_nutrition,
    values.working_nutrition_override,
    values.working_nutrition,
    values.evidence_class,
    values.estimate_low,
    values.estimate_high,
    values.status,
    values.revision,
    values.deleted_at,
  ];
}

function firstRow<Row>(rows: readonly unknown[]): Row | undefined {
  return rows[0] as Row | undefined;
}

function consumedTimeParameters(
  input: CreateFoodEntryRecord,
): readonly [string | null, ConsumedTimePrecision | null] {
  if (
    (input.consumedAt === undefined) !==
    (input.consumedTimePrecision === undefined)
  ) {
    throw new DomainValidationError(
      "consumedAt and consumedTimePrecision must be provided together.",
    );
  }
  return [input.consumedAt ?? null, input.consumedTimePrecision ?? null];
}
