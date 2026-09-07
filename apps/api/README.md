# API database runtime

`apps/api` owns the production `pg` pool lifecycle. Construct it explicitly with
`createPostgresRuntime({ connectionString })`, then call `await runtime.close()`
to delegate shutdown to `pool.end()`. Imports create no pool or connection;
construction creates an empty pool whose connections are acquired lazily.
Blank connection strings are rejected without including credentials in errors.
The runtime does not read environment variables or log database URLs.

`PostgresPoolTransactionRunner` acquires one PoolClient per transaction and
passes that same client as the persistence `PostgresExecutor`. BEGIN, callback
queries, and COMMIT/ROLLBACK all use that client. Pass the callback executor to
repositories; pass the runner to persistence workflows. Do not use `pool.query`
for queries that belong inside a transaction.

Callback failure attempts rollback and rethrows the original error. BEGIN
failure skips the callback and discards the client without assuming a transaction
exists. COMMIT failure attempts rollback, propagates failure, and discards the
client even if cleanup succeeds; the commit outcome may still be uncertain.
Rollback failure throws an `AggregateError` containing the original and rollback
errors (with the rollback error as `cause`) and discards the client. Acquired clients
are always released exactly once; no retry or transaction takeover is added.

The future bootstrap owns shutdown and background pool-error policy. Attach a
`runtime.pool.on("error", handler)` listener before database use; the runtime
does not silently swallow idle-connection errors or install global handlers.

Normal `corepack pnpm check` remains database-independent. The opt-in integration
suite uses this production runtime to verify commit visibility on a separate
connection, rollback, and stable backend PID within a transaction. From a host
PowerShell terminal with local Supabase/PostgreSQL running:

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
corepack pnpm --filter @cal-calc/api test:integration
```

This direct PostgreSQL suite does not prove RLS; existing Supabase Auth/RLS tests
remain separate. HTTP routing, authentication, trusted request identity, and
OpenAI integration are not implemented here. This is database wiring, not a
deployed API.
