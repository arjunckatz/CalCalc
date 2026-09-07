import { Pool } from "pg";

import { PostgresPoolTransactionRunner } from "./transaction-runner.js";

export interface PostgresRuntimeConfig {
  readonly connectionString: string;
}

export interface PostgresRuntime {
  readonly pool: Pool;
  readonly transactionRunner: PostgresPoolTransactionRunner;
  close(): Promise<void>;
}

export function createPostgresRuntime(
  config: PostgresRuntimeConfig,
): PostgresRuntime {
  if (config.connectionString.trim() === "") {
    throw new TypeError("PostgreSQL connectionString must not be blank.");
  }
  const pool = new Pool({ connectionString: config.connectionString });
  return {
    pool,
    transactionRunner: new PostgresPoolTransactionRunner(pool),
    close: () => pool.end(),
  };
}
