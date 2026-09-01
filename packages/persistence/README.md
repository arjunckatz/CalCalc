# Persistence contract

PostgreSQL `numeric` is the canonical exact storage for quantities, nutrition
bases, and target snapshots. Nutrition values inside JSONB are canonical M1
decimal strings.

Database adapters must transport PostgreSQL `numeric` values to the domain as
strings or another proven exact-decimal representation. They must never pass
canonical quantity or nutrition values through JavaScript `Number`.

The mapping unit tests prove string-level precision only; they are not a real
PostgreSQL round trip. The opt-in `test:integration` script queries PostgreSQL
through `pg` without a custom numeric type parser and asserts that `numeric`
values arrive as exact strings rather than JavaScript numbers. It also verifies
that JSONB nutrition decimal strings and absent optional nutrients are
preserved. Run it from PowerShell against the local Supabase database with:

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
corepack pnpm --filter @cal-calc/persistence test:integration
```

This transport test does not prove repository behavior. PostgREST and
Supabase-client numeric transport must not be assumed exact until separately
verified.

Food-entry revisions reject ordinary updates and authenticated users receive no
revision-history delete policy. A universal delete-rejection trigger is
intentionally omitted so a future explicitly privileged privacy-purge workflow
can truly remove a user's records. That workflow is outside M2A.
