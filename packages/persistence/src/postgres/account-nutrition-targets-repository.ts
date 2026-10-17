import { normalizeDecimal } from "@cal-calc/domain";

import type { AccountNutritionTargets } from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

const maxVersion = 2_147_483_647;

export interface SetAccountNutritionTargetsRecord {
  readonly userId: string;
  /** Null is an initial-create precondition, not a request to overwrite. */
  readonly expectedVersion: number | null;
  readonly calorieTarget: string;
  readonly proteinTarget: string;
}

export class AccountNutritionTargetsVersionConflictError extends Error {
  override readonly name = "AccountNutritionTargetsVersionConflictError";

  constructor() {
    super("Account nutrition targets changed since this command was prepared.");
  }
}

export class PostgresAccountNutritionTargetsRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async findByUser(userId: string): Promise<AccountNutritionTargets | null> {
    return this.loadByUser(userId, false);
  }

  /** Keep an automatic FoodDay's default snapshot stable through transaction commit. */
  async findByUserForShare(
    userId: string,
  ): Promise<AccountNutritionTargets | null> {
    return this.loadByUser(userId, true);
  }

  private async loadByUser(
    userId: string,
    forShare: boolean,
  ): Promise<AccountNutritionTargets | null> {
    const result = await this.executor.query(
      `select ${columns} from public.account_nutrition_targets
       where user_id = $1${forShare ? " for share" : ""}`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseRow(row);
  }

  /** Initial insert or one-step CAS. A losing explicit intent always conflicts. */
  async setWithExpectedVersion(
    input: SetAccountNutritionTargetsRecord,
  ): Promise<AccountNutritionTargets> {
    if (
      input.expectedVersion !== null &&
      (!Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        input.expectedVersion > maxVersion)
    ) {
      throw new TypeError("Invalid expected account target version.");
    }
    const calorieTarget = normalizeDecimal(input.calorieTarget, {
      label: "food day calorie target",
    });
    const proteinTarget = normalizeDecimal(input.proteinTarget, {
      label: "food day protein target",
    });
    const result =
      input.expectedVersion === null
        ? await this.executor.query(
            `insert into public.account_nutrition_targets
               (user_id, calorie_target, protein_target)
             values ($1, $2::numeric, $3::numeric)
             on conflict (user_id) do nothing
             returning ${columns}`,
            [input.userId, calorieTarget, proteinTarget],
          )
        : await this.executor.query(
            `update public.account_nutrition_targets
             set calorie_target = $3::numeric,
                 protein_target = $4::numeric,
                 version = version + 1
             where user_id = $1 and version = $2 and version < 2147483647
             returning ${columns}`,
            [input.userId, input.expectedVersion, calorieTarget, proteinTarget],
          );
    const row = result.rows[0];
    if (row === undefined)
      throw new AccountNutritionTargetsVersionConflictError();
    return parseRow(row);
  }
}

const columns = `user_id, calorie_target::text as calorie_target,
  protein_target::text as protein_target, version,
  to_jsonb(created_at) #>> '{}' as created_at,
  to_jsonb(updated_at) #>> '{}' as updated_at`;

function parseRow(value: unknown): AccountNutritionTargets {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("user_id" in value) ||
    typeof value.user_id !== "string" ||
    !("calorie_target" in value) ||
    typeof value.calorie_target !== "string" ||
    !("protein_target" in value) ||
    typeof value.protein_target !== "string" ||
    !("version" in value) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    !("created_at" in value) ||
    typeof value.created_at !== "string" ||
    !("updated_at" in value) ||
    typeof value.updated_at !== "string"
  ) {
    throw new TypeError(
      "PostgreSQL returned invalid account nutrition targets.",
    );
  }
  return {
    userId: value.user_id,
    calorieTarget: normalizeDecimal(value.calorie_target),
    proteinTarget: normalizeDecimal(value.protein_target),
    version: value.version as number,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}
