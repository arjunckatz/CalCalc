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
remain separate. HTTP routing and OpenAI integration are not implemented here.
This is application wiring, not a deployed API.

## Authenticated identity

Construct `createSupabaseAccessTokenVerifier({ supabaseUrl, supabasePublishableKey })`
explicitly, then call `authenticateAuthorizationHeader(verifier, authorization)`.
The parser accepts one Bearer credential (case-insensitive scheme), rejects missing,
blank, malformed, and ambiguous values, and never includes the token in errors.
The verifier calls `auth.getClaims(token)` with an explicit nonblank token and
default expiry verification. It does not trust `getSession()` or merely decode JWTs.

Supabase verifies signatures using its cached project JWKS where supported;
with symmetric signing keys or unavailable local verification it verifies through
the Auth server. Thus verification is not guaranteed to be network-free. See
[Supabase getClaims](https://supabase.com/docs/reference/javascript/auth-getclaims).
Only a verified nonblank string `sub` becomes `{ userId }`; metadata, email, and
request-supplied IDs cannot override it. One account remains one human user.

Production configuration needs only the Supabase URL and publishable key, never a
secret/service-role key. Blank configuration is rejected. No global client or
environment reads are used in the auth module. Session persistence, auto-refresh,
and URL session detection are disabled. Fixed `AuthenticationError` messages and
reason codes replace SDK failures without retaining potentially sensitive causes.

Ordinary authentication performs no application database lookup or profile
provisioning. Verified API identity does **not** install Supabase RLS context on
the privileged PostgreSQL pool. Future application calls must pass verified
`identity.userId` into ownership-scoped persistence methods; existing RLS tests
remain separate. There is no HTTP middleware, route, or request-body boundary yet.
Revocation policy, custom authorization, and refresh-token flows are outside this slice.

### Opt-in local Supabase Auth test

`test:integration:auth` exercises this production verifier with two independently
created/signed-in users, tampered-signature rejection, and subject-only ownership.
The admin credential is used only to create/delete randomized test users; no
profiles or ledger rows are created. The verifier and sign-in clients use the
publishable key. This is identity verification coverage, not RLS coverage.

Reuse the existing RLS suite's host environment variables: `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` (fixture-only). With keys
already set locally in PowerShell, run:

```powershell
$env:SUPABASE_URL = "http://127.0.0.1:54321"
corepack pnpm --filter @cal-calc/api test:integration:auth
```

Keep keys in the local environment; do not paste credentials into chat or source.
The existing `test:integration` command still runs only the PostgreSQL runtime
suite. Both host suites remain excluded from normal `corepack pnpm check`.
