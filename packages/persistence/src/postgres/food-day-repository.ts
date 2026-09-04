import type { FoodDay } from "@cal-calc/domain";

import { fromFoodDayRow, toFoodDayWriteValues } from "../mapping.js";
import type {
  FoodDayCompleteness,
  FoodDayRow,
  PersistedFoodDay,
} from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

export interface CreateFoodDayRecord {
  readonly userId: string;
  readonly foodDay: FoodDay;
  readonly completeness: FoodDayCompleteness;
  readonly localDate?: string;
  readonly timezone?: string;
}

export interface UpdateFoodDayRecord extends CreateFoodDayRecord {
  readonly closedAt?: string;
}

export class FoodDayNotFoundError extends Error {
  override readonly name = "FoodDayNotFoundError";

  constructor(readonly foodDayId: string) {
    super(`Food day ${foodDayId} was not found for this user.`);
  }
}

export class PostgresFoodDayRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async create(input: CreateFoodDayRecord): Promise<PersistedFoodDay> {
    const values = toFoodDayWriteValues(input.foodDay, input);
    const result = await this.executor.query(
      `insert into public.food_days (
         id,
         user_id,
         status,
         completeness,
         calorie_target,
         protein_target,
         maintenance_snapshot,
         goal_version_id,
         local_date,
         timezone
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning ${foodDayResultColumns}`,
      writeParameters(input.userId, values),
    );
    const row = firstRow(result.rows);
    if (row === undefined) {
      throw new Error("PostgreSQL returned no FoodDay after insert.");
    }
    return fromFoodDayRow(parseFoodDayRow(row));
  }

  async findById(
    userId: string,
    foodDayId: string,
  ): Promise<PersistedFoodDay | null> {
    const result = await this.executor.query(
      `select ${foodDayResultColumns}
       from public.food_days
       where id = $1
         and user_id = $2`,
      [foodDayId, userId],
    );
    const row = firstRow(result.rows);
    return row === undefined ? null : fromFoodDayRow(parseFoodDayRow(row));
  }

  async findByLocalDate(
    userId: string,
    localDate: string,
  ): Promise<PersistedFoodDay[]> {
    const result = await this.executor.query(
      `select ${foodDayResultColumns}
       from public.food_days
       where user_id = $1
         and local_date = $2::date
       order by opened_at asc, id asc`,
      [userId, localDate],
    );
    return result.rows.map((row) => fromFoodDayRow(parseFoodDayRow(row)));
  }

  async update(input: UpdateFoodDayRecord): Promise<PersistedFoodDay> {
    const values = toFoodDayWriteValues(input.foodDay, input);
    const result = await this.executor.query(
      `update public.food_days
       set status = $3,
           completeness = $4,
           calorie_target = $5,
           protein_target = $6,
           maintenance_snapshot = $7,
           goal_version_id = $8,
           local_date = $9,
           timezone = $10,
           closed_at = $11
       where id = $1
         and user_id = $2
       returning ${foodDayResultColumns}`,
      [...writeParameters(input.userId, values), values.closed_at],
    );
    const row = firstRow(result.rows);
    if (row === undefined) {
      throw new FoodDayNotFoundError(input.foodDay.id);
    }
    return fromFoodDayRow(parseFoodDayRow(row));
  }
}

const foodDayResultColumns = `
  id,
  user_id,
  status,
  completeness,
  calorie_target::text as calorie_target,
  protein_target::text as protein_target,
  maintenance_snapshot::text as maintenance_snapshot,
  goal_version_id,
  local_date::text as local_date,
  timezone,
  to_jsonb(opened_at) #>> '{}' as opened_at,
  to_jsonb(closed_at) #>> '{}' as closed_at,
  to_jsonb(created_at) #>> '{}' as created_at,
  to_jsonb(updated_at) #>> '{}' as updated_at
`;

function writeParameters(
  userId: string,
  values: ReturnType<typeof toFoodDayWriteValues>,
): unknown[] {
  return [
    values.id,
    userId,
    values.status,
    values.completeness,
    values.calorie_target,
    values.protein_target,
    values.maintenance_snapshot,
    values.goal_version_id,
    values.local_date,
    values.timezone,
  ];
}

function parseFoodDayRow(row: unknown): FoodDayRow {
  if (
    !isRecord(row) ||
    !isString(row.id) ||
    !isString(row.user_id) ||
    !isFoodDayStatus(row.status) ||
    !isFoodDayCompleteness(row.completeness) ||
    !isString(row.calorie_target) ||
    !isString(row.protein_target) ||
    !isNullableString(row.maintenance_snapshot) ||
    !isNullableString(row.goal_version_id) ||
    !isNullableString(row.local_date) ||
    !isNullableString(row.timezone) ||
    !isString(row.opened_at) ||
    !isNullableString(row.closed_at) ||
    !isString(row.created_at) ||
    !isString(row.updated_at)
  ) {
    throw new TypeError("PostgreSQL returned an invalid FoodDay row.");
  }
  return {
    id: row.id,
    user_id: row.user_id,
    status: row.status,
    completeness: row.completeness,
    calorie_target: row.calorie_target,
    protein_target: row.protein_target,
    maintenance_snapshot: row.maintenance_snapshot,
    goal_version_id: row.goal_version_id,
    local_date: row.local_date,
    timezone: row.timezone,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function firstRow(rows: readonly unknown[]): unknown {
  return rows[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isFoodDayStatus(value: unknown): value is FoodDayRow["status"] {
  return value === "OPEN" || value === "CLOSED" || value === "PROVISIONAL";
}

function isFoodDayCompleteness(value: unknown): value is FoodDayCompleteness {
  return (
    value === "UNKNOWN" ||
    value === "PARTIAL" ||
    value === "USER_DECLARED_COMPLETE"
  );
}
