import type { PostgresExecutor } from "./food-entry-repository.js";

export interface PostgresTransactionRunner {
  runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value>;
}
