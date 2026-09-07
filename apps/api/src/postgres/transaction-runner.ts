import type {
  PostgresExecutor,
  PostgresTransactionRunner,
} from "@cal-calc/persistence";
import type { PoolClient } from "pg";

type TransactionClient = PostgresExecutor & Pick<PoolClient, "release">;

interface ClientProvider {
  connect(): Promise<TransactionClient>;
}

export class PostgresPoolTransactionRunner implements PostgresTransactionRunner {
  constructor(private readonly pool: ClientProvider) {}

  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.pool.connect();
    let phase: "begin" | "work" | "commit" = "begin";
    let discard = false;
    try {
      await client.query("BEGIN");
      phase = "work";
      const result = await work(client);
      phase = "commit";
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // Failed BEGIN or COMMIT leaves connection/outcome uncertainty.
      discard = phase !== "work";
      if (phase !== "begin") {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          discard = true;
          throw new AggregateError(
            [error, rollbackError],
            "PostgreSQL transaction failed and rollback also failed.",
            { cause: rollbackError },
          );
        }
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
