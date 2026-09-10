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
remain separate. OpenAI integration is not implemented here.
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
the privileged PostgreSQL pool. Application calls must pass verified
`identity.userId` into ownership-scoped persistence methods; existing RLS tests
remain separate. The read-only HTTP boundary below now uses this identity.
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
suite. All host suites remain excluded from normal `corepack pnpm check`.

## Read-only HTTP boundary

`createApiApp({ authVerifier, postgres })` constructs an independent Fastify app;
pass the production verifier and `runtime.pool` as the PostgreSQL executor.
It reads no environment variables, creates no pool/client, and never starts a
server on import or construction. There is no production TCP listen/bootstrap yet.
The caller owns shutdown: `await app.close()`, then `await runtime.close()`.
Fastify logging is disabled. No auth/framework plugins are installed.

The only product endpoint is `GET /v1/food-days/:foodDayId`. A small reusable
authenticated-handler wrapper calls the existing M3B verification boundary and
passes only `{ userId }` as identity to the handler. It reads raw header pairs
without mutation and rejects duplicate Authorization occurrences, regardless of
header-name casing. The transport header remains part of the request lifecycle;
the token is not copied into custom application state or promoted into identity.
The verified JWT subject is the sole ownership identity, never query/body/route
user IDs or `X-User-Id`. Logging remains disabled; no token-erasure guarantee is made.

After authentication, the handler validates the UUID-shaped ID and calls
`PostgresFoodDayRepository.findById(identity.userId, foodDayId)`. This is one
ownership-scoped SELECT through the injected executor, without a transaction.
This is application ownership enforcement, **not** proof of PostgreSQL RLS.

A successful response is a flat, explicitly mapped DTO with exactly:
`id`, `status`, `completeness`, `calorieTarget`, `proteinTarget`, `localDate`,
`timezone`, `openedAt`, `closedAt`, `createdAt`, and `updatedAt`.
Targets remain canonical decimal strings. Missing `localDate`, `timezone`, and
`closedAt` are explicit JSON `null`; present dates/timestamps remain strings.
No `userId`, goal-version ID, maintenance snapshot, or persistence object is exposed.

Errors use `{ "error": { "code": "...", "message": "..." } }` with fixed text:

- Missing/malformed/invalid credentials: 401 `UNAUTHENTICATED`.
- Malformed URL encoding rejected by the router: 400 `INVALID_REQUEST`.
- Excessive route-parameter length rejected by the router: 414 `URI_TOO_LONG`.
- Malformed UUID after authentication: 400 `INVALID_FOOD_DAY_ID`.
- Missing or cross-account day: identical 404 `NOT_FOUND`.
- Unexpected verifier/persistence/server failure: 500 `INTERNAL_ERROR`.

Router URL errors use fixed JSON responses without reflecting the original path,
and are rejected before authentication or PostgreSQL access. A normally parsed
route with a non-UUID ID still uses `INVALID_FOOD_DAY_ID` after authentication.
No SDK/SQL messages, credentials, or stacks are returned. Unknown routes also use
the sanitized 404 shape. HTTP mutations remain deferred; the application-owned
identity primitive below is not yet wired to HTTP.

### Opt-in HTTP integration test

Normal tests use real Fastify `app.inject()` and narrow verifier/executor fakes;
they require no host services or listening port. `test:integration:http` instead
uses real local Supabase Auth, the production verifier/runtime/app, and the real
FoodDay repository, still through injection with no TCP listen. It creates two
randomized Auth users, fixture profiles and FoodDays, verifies own reads,
bidirectional cross-account 404s, irrelevant spoofed user IDs, missing/tampered
token 401s, and malformed UUID 400s. Cleanup removes FoodDays, profiles, then Auth
users, and attempts both app and pool shutdown even if cleanup fails.

With `SUPABASE_PUBLISHABLE_KEY` and fixture-only `SUPABASE_SECRET_KEY` already set
locally in PowerShell:

```powershell
$env:SUPABASE_URL = "http://127.0.0.1:54321"
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
corepack pnpm --filter @cal-calc/api test:integration:http
```

Keep credentials local. The existing PostgreSQL and Auth integration scripts are
unchanged. This suite is not a deployment, load test, or RLS test.

## Application-owned mutation identity

`deriveMutationIdentity({ trustedUserId, action, idempotencyKey, semanticPayload })`
returns `{ operationKey, requestFingerprint }` without IO. Application code must
explicitly supply verified `identity.userId`, the literal `CREATE_FOOD_DAY` action,
and a validated semantic command, never spread request/tool input into this call.
This primitive does not authenticate users or validate FoodDay command meaning.
The caller's opaque retry handle is parsed with `parseIdempotencyKey`: exactly
1–128 ASCII characters from `A–Z a–z 0–9 . _ ~ -`, with no trimming.

Internal identity is application-derived, not caller-supplied. SHA-256 hashes
JSON-array-framed material with separate operation/fingerprint purpose labels,
`v1`, action, and trusted user. The operation hash adds the retry key and yields
`calcalc:v1:CREATE_FOOD_DAY:<64 hex characters>`; the 64-hex fingerprint instead
adds the canonical semantic command. Neither output embeds raw user/key/payload
values; hashing is not encryption or a guarantee against guessing low-entropy input.
Same retry plus changed meaning retains the operation key but changes the
fingerprint, allowing existing persistence to reject the conflict. A new retry
key represents new explicit intent even for identical content.

The internal canonicalizer sorts plain-object keys recursively and preserves
array order and exact strings. Null, booleans, and finite JSON numbers are
supported (JSON number rules, including `-0` becoming `0`). Decimal nutrition
values must be canonical strings supplied by the command builder: `"119"`,
`"119.0"`, and `"119.00"` deliberately remain distinct here. Undefined, nonfinite
numbers, classes/Dates, functions, symbols, bigint, accessors, non-enumerable
properties, sparse/extended arrays, and cycles are rejected. Do not include raw
HTTP bytes, headers/tokens, retry keys, or generated IDs/timestamps in the semantic
command. Changes to derivation/canonicalization semantics require a version bump.

Future HTTP/agent mutations must use this boundary; there is no mutation route,
retry-header parser, or workflow invocation yet. Existing exactly-once persistence
workflows and schema remain unchanged; `requestFingerprint` matches their input.
