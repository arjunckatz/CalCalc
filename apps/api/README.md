# API database runtime

For the temporary local browser demo, set `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `OPENAI_API_KEY`, and `OPENAI_MODEL` in the API
process environment, then run `corepack pnpm --filter @cal-calc/api dev:server`.
This thin entry point uses the production host factory and binds only
`127.0.0.1:3001`. Stop it with Ctrl+C; it closes Fastify and the PostgreSQL
pool. The web dev server proxies `/v1` to that listener. No browser secrets,
production CORS policy, or model/ledger behavior are changed.

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

The host caller owns background pool-error policy. Attach a
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
remain separate. The HTTP boundary below uses this identity.
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

## Authenticated HTTP boundary

`createApiApp({ authVerifier, postgres, transactionRunner })` constructs an independent
Fastify app; pass the production verifier, `runtime.pool` as the PostgreSQL executor,
and `runtime.transactionRunner` for exactly-once writes.
It reads no environment variables, creates no pool/client, and never starts a
server on import or construction. There is no production TCP listen/bootstrap yet.
The caller owns shutdown: `await app.close()`, then `await runtime.close()`.
Fastify logging is disabled. No auth/framework plugins are installed. The
explicit `createApiHostFromEnvironment()` composition factory creates the
PostgreSQL runtime, Supabase verifier, OpenAI client/model adapter, turn runner,
and app, but still performs no eager connection or TCP listen. It requires
`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OPENAI_API_KEY`, and
`OPENAI_MODEL` only when called. The caller still owns listen timing, idle-pool
error policy, and `host.close()`.

The read endpoint is `GET /v1/food-days/:foodDayId`. A small reusable
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
the sanitized 404 shape.

### Exactly-once FoodDay creation

`POST /v1/food-days` requires verified Bearer identity and exactly one
`Idempotency-Key` header. Raw header occurrences are inspected read-only,
case-insensitively; missing, duplicate, or invalid values return fixed 400
`INVALID_IDEMPOTENCY_KEY` responses. The existing M3D key grammar applies without
trimming. Keys and tokens are not logged or reflected in responses.

The JSON object accepts only these fields:

```json
{
  "calorieTarget": "2400.0",
  "proteinTarget": "119.00",
  "localDate": "2026-09-10",
  "timezone": "UTC"
}
```

Both targets are required strings: at most 128 characters before trimming,
nonnegative plain decimal text (`digits` or `digits.digits`). JSON numbers,
exponents, signs, and hexadecimal notation are rejected. Existing domain decimal
normalization removes insignificant zeros without converting nutrition through
JavaScript Number. Optional `localDate` and `timezone` independently default to
null. Dates must be real Gregorian `YYYY-MM-DD` dates in years 0001–9999. Timezones
must be nonblank, at most 128 characters from letters, digits, `_`, `+`, `-`, `/`,
and accepted by `Intl.DateTimeFormat`; their spelling is preserved. Unknown fields
are rejected with 400 `INVALID_CREATE_FOOD_DAY` before identity derivation or SQL.

`createFoodDayMutation({ transactionRunner }, { trustedUserId, idempotencyKey, command })`
revalidates the command and hardcodes `CREATE_FOOD_DAY`. Its normalized semantic
payload contains the four command fields plus `status: OPEN` and `completeness:
UNKNOWN`. It calls M3D derivation and the unchanged `createFoodDayExactlyOnce`
workflow with the production transaction runner. FoodDay and operation UUIDs are
server-generated; PostgreSQL supplies `openedAt` and creation/update timestamps.
Generated IDs/timestamps, raw headers, URLs, and retry keys are not fingerprinted.
The verified subject is the only owner: query/header spoofing cannot override it;
body ownership, IDs, operation keys, fingerprints, status, and completeness are
unknown fields and rejected.

The authoritative result is `{ disposition, foodDay }`, using exactly the explicit
FoodDay DTO described above, not an operation record or persistence object:

- New operation: 201 with `CREATED`.
- Same key and normalized command: 200 with `REPLAYED`, returning the original
  canonical FoodDay. For example, `2400.0` and `2400.00` fingerprint identically.
- Same key with changed meaning: fixed 409 `IDEMPOTENCY_CONFLICT`.
- Known existing PENDING/FAILED operation: fixed 409 `OPERATION_NOT_REPLAYABLE`.
- Corrupt stored result, missing replay target, or unexpected failure: fixed 500
  `INTERNAL_ERROR`, never raw SQL/SDK errors.

A new key represents new explicit intent, even with identical content/localDate.
Multiple OPEN days on the same local date remain allowed. No active-day lookup,
automatic closure, date deduplication, or midnight inference is added.

POST has a 16 KiB body limit. Known Fastify invalid/empty JSON and content-length
errors return fixed 400 `INVALID_REQUEST`; unsupported media types return fixed
415 `UNSUPPORTED_MEDIA_TYPE`; oversized bodies return fixed 413 `PAYLOAD_TOO_LARGE`.
These parser failures can precede authentication. Existing URL hardening remains.

### Opt-in HTTP integration test

Normal tests use real Fastify `app.inject()` and narrow verifier/executor fakes;
they require no host services or listening port. `test:integration:http` instead
uses real local Supabase Auth, the production verifier/runtime/app, and the real
FoodDay repository, still through injection with no TCP listen. It creates two
randomized Auth users, fixture profiles and FoodDays, verifies own reads,
bidirectional cross-account 404s, irrelevant spoofed user IDs, missing/tampered
token 401s, and malformed UUID 400s. Cleanup removes FoodDays, profiles, then Auth
users, and attempts both app and pool shutdown even if cleanup fails.

The script also includes the POST suite: real creation/ownership, exact and
decimal-normalized replay with row/operation counts, changed-command conflict,
distinct same-date creation, independent users reusing a key, ownership spoofing,
invalid/duplicate keys, and missing/tampered authentication. It uses the production
transaction runner and workflow, not a local duplicate. Randomized fixtures are
cleaned up in FoodDay/operation/profile/Auth order, with all cleanup attempts and
app/runtime shutdown preserved via aggregate failure reporting. These host suites
must be run separately; normal CI does not establish real database behavior.

With `SUPABASE_PUBLISHABLE_KEY` and fixture-only `SUPABASE_SECRET_KEY` already set
locally in PowerShell:

```powershell
$env:SUPABASE_URL = "http://127.0.0.1:54321"
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
corepack pnpm --filter @cal-calc/api test:integration:http
```

Keep credentials local. The existing PostgreSQL and Auth integration scripts are
unchanged. This suite is not a deployment, load test, or RLS test.

### Authenticated FoodDay conversational turn

The model-facing tool set includes `CHANGE_FOOD_STATUS`, which can transition an
existing FoodEntry among the canonical statuses. Natural-language status
selection has not yet been live-evaluated.

`POST /v1/food-days/:foodDayId/turns` requires verified Bearer identity, one
valid `Idempotency-Key`, a UUID-shaped FoodDay ID, and the strict body
`{ "message": string, "currentLocalDate"?: "YYYY-MM-DD" }`. The optional date
must be an exact valid Gregorian date; malformed dates, whitespace-only messages,
and unknown fields are rejected. This client-resolved date is accepted calendar
context for this turn, not proof of location or timezone. The HTTP adapter passes
the unchanged message, optional context, trusted identity, FoodDay, and parsed
retry key to the injected provider-neutral turn runner. It
does not load ownership separately, execute tools, perform nutrition arithmetic,
or construct provider clients.

Success always returns only `{ "response": string }`. The initial STATE, rich
tool results, generated child keys, operation identity, and provider metadata are
not public HTTP fields. The STATE returned internally by M4B2 is the initial
pre-mutation snapshot and is deliberately not exposed as current state.

After initial tools execute in order, one model step may either answer or request
the strict, zero-argument `GET_BODY_WEIGHT_HISTORY` read. The read uses the same
trusted owner-scoped query and projection as an initial history tool call; no
mutation tool is offered in this continuation. A requested read is appended to
the ordered results before one tool-free final response. Thus a no-tool turn
uses one model call, an initial-tool turn normally uses two, and a turn needing
the single read continuation uses at most three. There is no recursive tool
loop or transaction spanning model calls.

The HTTP key is the trusted turn key; M4B2 derives mutation child keys from that
key and zero-based tool slots. After a successful turn response is durably
recorded, an exact retry for the same trusted user, FoodDay, key, message, and
optional currentLocalDate
returns the first stored public response without loading STATE, calling the
model, or executing tools. Reusing that scoped key with a changed message or
currentLocalDate is an idempotency conflict. Completed-turn persistence stores no STATE, tool results,
or provider IDs. It retains the exact accepted user message with the terminal
public assistant response as the minimal successful transcript pair for future
continuity. Before a new turn asks the model to decide, the application loads up
to eight recent successful pairs for the same trusted user and FoodDay and
supplies them in chronological order. This bounded transcript assists local
conversational continuity only: fresh canonical STATE and current tool results
remain authoritative for ledger facts. It is not cross-day or global memory, and
no provider conversation state or response ID is used.

This is completed-result replay, not in-flight request coalescing. Concurrent
duplicates that both miss before either result is recorded may both consume
model work and may both reach tool execution. Tool mutations retain their own
idempotency/conflict protection. The final result insert race stores one
immutable winner; both callers adopt that first persisted response. If response
persistence fails after tools commit, their independently idempotent mutations
remain authoritative and a later retry may run model reasoning again.

Missing/cross-account FoodDays share the sanitized 404 response. Existing
operation and revision conflicts retain their established mappings. Known model
protocol failures return a fixed 502 response; all other unexpected failures
remain fixed, non-reflective 500 responses. No provider objects, IDs, request
bodies, SDK messages, tokens, or retry keys are serialized.

Normal tests inject a fake turn runner and require no OpenAI key. The opt-in HTTP
integration suite injects a deterministic fake model while exercising real
Supabase Auth, PostgreSQL, canonical STATE, M4B2, M4B1 tools, application
mutations, and persistence. It proves a no-write FINAL turn and a LOG_FOOD turn
whose exact completed retry performs no model call and creates no duplicate
entry, revision, semantic operation, or completed-turn row. Changed-message key
reuse conflicts before model or ledger execution.
The existing `test:integration:http` command runs it with the other host HTTP
suites; it makes no paid OpenAI request.

### Opt-in live conversation eval

With `OPENAI_API_KEY` and `OPENAI_MODEL` set locally, run
`corepack pnpm --filter @cal-calc/api eval:openai:food-day-conversation`.
This runs four focused same-FoodDay continuity scenarios with up to four paid
OpenAI Responses requests against synthetic canonical STATE and recent transcript.
It requires no database and is excluded from normal API tests and CI. A passing
run establishes only these fixtures, not general conversational reliability.

The separate opt-in FoodEntry status-semantic eval uses the real OpenAI API with
`OPENAI_API_KEY` and `OPENAI_MODEL` set locally:
`corepack pnpm --filter @cal-calc/api eval:openai:food-day-status-semantics`.
It is excluded from normal tests, needs no database, and makes at most four
provider requests. Its four scenarios evaluate a genuine plan, actual
consumption, non-consumption, and an explicit hypothetical for existing entries.
An owner-run live eval passed all four fixtures (4/4). This establishes only
these synthetic existing-entry cases, not general status-language reliability
or new-entry planning behavior.

The separate opt-in new-entry semantic eval uses the real OpenAI API and requires
`OPENAI_API_KEY` and `OPENAI_MODEL`. Run
`corepack pnpm --filter @cal-calc/api eval:openai:food-day-new-entry-semantics`
to evaluate four focused cases: a genuine new plan, actual new consumption, an
explicit hypothetical, and a casual possibility. It is excluded from normal
tests and CI, requires no database, and makes at most four paid decision calls.
An owner-run live eval passed all four fixtures (4/4). This establishes only
these synthetic new-entry cases, not general new-entry language reliability.

The separate opt-in FoodDay completeness semantic eval uses the real OpenAI API
and requires `OPENAI_API_KEY` and `OPENAI_MODEL`. Run
`corepack pnpm --filter @cal-calc/api eval:openai:food-day-completeness-semantics`
to assess six focused decisions: explicit completion, explicit incompleteness,
retracting completion, redundant-completion no-op avoidance, ordinary food
logging without completeness inference, and compound food logging before
completion. It is excluded from normal tests and CI, requires no database, and
makes at most six paid decision calls. An owner-run live eval passed all six
fixtures (6/6). This establishes only these synthetic cases, not general
completeness-language reliability.

The dedicated opt-in target-progress semantic eval requires `OPENAI_API_KEY` and
`OPENAI_MODEL`. Run
`corepack pnpm --filter @cal-calc/api eval:openai:food-day-target-progress-semantics`
to examine exactly six cases: incomplete and complete below-target calories,
incomplete over-target calories, complete exact-target calories, unknown protein,
and stale pre-mutation progress after food logging. It uses the production OpenAI
adapter without a database or backend mutation executor, makes at most seven paid
Responses API calls with retries disabled, and is excluded from normal tests/CI.
The first owner live run passed A/B/C/E/F (5/6). Scenario D passed a targeted
one-test rerun after an eval-only assertion repair; its fixture and the production
prompt were unchanged. All six fixtures have an owner live pass across two runs,
not one clean 6/6 run. These synthetic cases do not establish general
target-progress reliability.

The opt-in body-weight semantic eval has owner live semantic evidence for all
seven cases across an initial full run and targeted reruns, not one clean 7/7
run. The negated-date
case required prompt-policy tuning; final targeted checks for that case and
the correction case passed. With
`OPENAI_API_KEY` and `OPENAI_MODEL` set locally, run
`corepack pnpm --filter @cal-calc/api eval:openai:body-weight-semantics`.
It covers exactly seven conversational cases: an actual dated observation,
an unrelated appointment date, competing dates, a negated date, a goal,
a correction request, and transcript-only history. The earlier live result for
the transcript-only case predates the canonical history read: that case now
expects one `GET_BODY_WEIGHT_HISTORY` decision, which has not yet been run live.
It uses the production
OpenAI adapter, prompts, and tool parser with synthetic FoodDay STATE, requires
no database or backend mutation, and makes at most eight Responses calls on a
successful run with retries disabled. It is excluded from normal tests/CI.
The deterministic executor guard checks current-message date/unit evidence;
it does not prove that a date semantically belongs to the weigh-in.
When `currentLocalDate` is supplied, it also permits standalone `today` and
`yesterday`, resolving the latter by Gregorian calendar arithmetic. Without
that context, relative dates still require clarification. An omitted date never
defaults to today. FoodDay.localDate remains separate from conversational civil
date, and the LOG_BODY_WEIGHT schema is unchanged. These relative-date paths
have offline validation and one clean owner-run live semantic eval.

The opt-in M4D6B relative-date eval passed one full owner run: one file and all
six scenarios passed. With `OPENAI_API_KEY` and `OPENAI_MODEL` set locally, run
`corepack pnpm --filter @cal-calc/api eval:openai:body-weight-relative-date-semantics`.
It covers exactly six decision-only cases: today, yesterday, competing relative
dates, correction safety, yesterday without context, and an omitted date despite
context. It uses the production OpenAI adapter, prompt, parser, and tool schemas
with production-built synthetic FoodDay STATE. The client-supplied
`currentLocalDate` is turn context, not FoodDay.localDate. No database or mutation
executor is used; with retries disabled, a successful full run makes at most six
Responses calls. It is excluded from normal tests/CI. Deterministic executor date
eligibility does not establish semantic clause association; that is what this
live eval examines.

The internal `getBodyWeightHistory` application query reads owner-scoped canonical
observations with a fixed 30-observation recent bound. `latestMeasurementDate`
is the maximum observation local date; `latestDateObservations` retains every
observation on that date, including multiple same-day weigh-ins. `createdAt`
only breaks presentation ties and is not measurement time. The conversation model
can request the bounded, owner-scoped history through `GET_BODY_WEIGHT_HISTORY`;
there is no separate HTTP history route, current-weight field, or trend math.

M4D7C adds an opt-in live semantic eval. With `OPENAI_API_KEY` and
`OPENAI_MODEL` set locally, run
`corepack pnpm --filter @cal-calc/api eval:openai:body-weight-history-semantics`.
Its eight synthetic cases exercise the production OpenAI adapter, prompts, parser,
and finalizer with fabricated authoritative history tool results. They cover
canonical empty/unique/ambiguous latest-date answers, raw and bounded history,
ordered log-then-read or one post-log read continuation, unsupported trend math,
and stale read-before-log refresh. F accepts either an initial LOG/GET batch or
LOG followed by one read continuation; H tests a fresh read after GET/LOG.
Canonical history must outrank transcript; historical M4D5 case G now expects
the read tool because that capability did not exist during its earlier live run.
The harness performs no database read or backend mutation, is excluded from
normal tests/CI, disables retries, and makes at most 16 Responses calls on a
successful full run (F uses two or three). Owner semantic evidence is complete
across runs, not from one clean 8/8 invocation: A's safe empty-history answer
and H's safe fresh-read answer have exact captured-output detector regressions;
B–E passed live; F passed a targeted live continuation after the acknowledgment
repair; G passed targeted live after the unsupported-calculation policy repair;
and H's fresh continuation read executed live before its safe final answer. No
further paid rerun is required for this slice.

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

The POST application mutation above uses this boundary after decimal command
normalization. Existing exactly-once persistence workflows and schema remain
unchanged; `requestFingerprint` matches their input.
