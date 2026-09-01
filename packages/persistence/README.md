# Persistence contract

PostgreSQL `numeric` is the canonical exact storage for quantities, nutrition
bases, and target snapshots. Nutrition values inside JSONB are canonical M1
decimal strings.

Database adapters must transport PostgreSQL `numeric` values to the domain as
strings or another proven exact-decimal representation. They must never pass
canonical quantity or nutrition values through JavaScript `Number`.

The mapping unit tests prove string-level precision only; they are not a real
PostgreSQL round trip. M2B must add an integration test against PostgreSQL that
proves the selected driver preserves exact numeric values. In particular,
PostgREST and Supabase-client numeric transport must not be assumed exact until
that behavior is verified.

Food-entry revisions reject ordinary updates and authenticated users receive no
revision-history delete policy. A universal delete-rejection trigger is
intentionally omitted so a future explicitly privileged privacy-purge workflow
can truly remove a user's records. That workflow is outside M2A.
