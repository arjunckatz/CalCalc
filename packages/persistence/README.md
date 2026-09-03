# Persistence contract

PostgreSQL `numeric` is the canonical exact storage for quantities, nutrition
bases, and target snapshots. Nutrition values inside JSONB are canonical M1
decimal strings.

Database adapters must transport PostgreSQL `numeric` values to the domain as
strings or another proven exact-decimal representation. They must never pass
canonical quantity or nutrition values through JavaScript `Number`.

The mapping unit tests prove string-level precision only; they are not a real
PostgreSQL round trip. The opt-in `test:integration` script contains real
PostgreSQL numeric-transport, canonical-ledger invariant, and FoodEntry
repository tests. It queries through `pg` without a custom numeric type parser
and asserts that `numeric` values arrive as exact strings rather than JavaScript
numbers. It also verifies that JSONB nutrition decimal strings and absent
optional nutrients are preserved. Run the integration tests from PowerShell
against a running local Supabase database with:

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
corepack pnpm --filter @cal-calc/persistence test:integration
```

The numeric-transport and invariant tests do not by themselves prove repository
behavior. PostgREST/Supabase-client numeric transport is not covered yet and
must be verified separately.

The separate `test:integration:rls` script verifies Supabase Auth and RLS with
two temporary, independently authenticated CAL CALC accounts. One account
represents one human user; account sharing and sub-users are not supported. The
test requires `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and
`SUPABASE_SECRET_KEY`. The secret key is restricted to test fixture setup and
cleanup and must never ship in client code.

The first production PostgreSQL repository persists FoodEntries through an
existing caller-supplied query executor. Every read and update scopes by both
entry ID and user ID, and updates additionally require the expected revision in
the SQL predicate. The repository exposes no physical delete operation;
logical deletion is persisted through ordinary revisioned updates. Its real
PostgreSQL integration coverage remains opt-in through `test:integration`.

Durable semantic operations use a focused PostgreSQL repository with
`userId + operationKey` as the idempotency scope. Atomic claims replay an
existing operation only when its request fingerprint matches; mismatches are
rejected. Completion permits only `PENDING` to `SUCCEEDED` or `FAILED`, and the
real PostgreSQL repository tests remain opt-in through `test:integration`.

Food-entry revisions reject ordinary updates and authenticated users receive no
revision-history delete policy. A universal delete-rejection trigger is
intentionally omitted so a future explicitly privileged privacy-purge workflow
can truly remove a user's records. That workflow is outside M2A.
