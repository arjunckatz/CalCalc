import { parseAccountTurnStepResult } from "../account-turn-values.js";
import type {
  AccountTurnStepResult,
  PersistedAccountTurnStepResult,
} from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

export interface SetAccountTurnStepResultInput {
  readonly userId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly result: AccountTurnStepResult;
}

/** The table's parent-row lock and trigger enforce plan membership and prefix order. */
export class PostgresAccountTurnStepResultRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async listForTurn(
    userId: string,
    turnId: string,
  ): Promise<readonly PersistedAccountTurnStepResult[]> {
    const result = await this.executor.query(
      `select turn_id, user_id, ordinal, result,
              to_jsonb(created_at) #>> '{}' as created_at
       from public.account_turn_step_results
       where user_id = $1 and turn_id = $2
       order by ordinal asc`,
      [userId, turnId],
    );
    return result.rows.map(parseRow);
  }

  async setOnce(
    input: SetAccountTurnStepResultInput,
  ): Promise<PersistedAccountTurnStepResult> {
    if (
      !Number.isSafeInteger(input.ordinal) ||
      input.ordinal < 0 ||
      input.ordinal > 7
    )
      throw new RangeError("Invalid account turn step ordinal.");
    const normalized = parseAccountTurnStepResult(input.result);
    const inserted = await this.executor.query(
      `insert into public.account_turn_step_results
         (turn_id, user_id, ordinal, result)
       values ($1, $2, $3, $4::jsonb)
       on conflict (turn_id, ordinal) do nothing
       returning turn_id, user_id, ordinal, result,
                 to_jsonb(created_at) #>> '{}' as created_at`,
      [input.turnId, input.userId, input.ordinal, JSON.stringify(normalized)],
    );
    if (inserted.rows[0] !== undefined) return parseRow(inserted.rows[0]);
    const found = await this.executor.query(
      `select turn_id, user_id, ordinal, result,
              to_jsonb(created_at) #>> '{}' as created_at
       from public.account_turn_step_results
       where user_id = $1 and turn_id = $2 and ordinal = $3`,
      [input.userId, input.turnId, input.ordinal],
    );
    if (found.rows[0] === undefined)
      throw new TypeError("Account turn step result did not converge.");
    return parseRow(found.rows[0]);
  }
}

function parseRow(value: unknown): PersistedAccountTurnStepResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("turn_id" in value) ||
    typeof value.turn_id !== "string" ||
    !("user_id" in value) ||
    typeof value.user_id !== "string" ||
    !("ordinal" in value) ||
    !Number.isSafeInteger(value.ordinal) ||
    (value.ordinal as number) < 0 ||
    !("result" in value) ||
    !("created_at" in value) ||
    typeof value.created_at !== "string"
  )
    throw new TypeError("Invalid account turn step result row.");
  return {
    turnId: value.turn_id,
    userId: value.user_id,
    ordinal: value.ordinal as number,
    result: parseAccountTurnStepResult(value.result),
    createdAt: value.created_at,
  };
}
