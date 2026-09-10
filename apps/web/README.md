# Experimental CalCalc web client

A removable React + TypeScript + Vite adapter with Redux Toolkit, React Redux,
Supabase browser authentication, and plain responsive HTML/CSS. It consumes only
the public `POST /v1/food-days` contract. No domain/persistence imports or database
access; the backend owns validation, ownership, decimal normalization, mutation
identity, and canonical state.

## Run

Copy `.env.example` to `.env.local` and supply only:

- `VITE_SUPABASE_URL`: your public Supabase project URL.
- Exactly one of `VITE_SUPABASE_PUBLISHABLE_KEY` (modern `sb_publishable_` key)
  or `VITE_SUPABASE_ANON_KEY` (legacy Supabase `anon` JWT). Leave the other empty.
- `VITE_CALCALC_API_URL`: a reachable CalCalc HTTP base URL.

Never provide a service/secret credential or database URL. Vite's automatic env
exposure is disabled; the build selects only the listed values. Both-set and
neither-set configurations fail with fixed errors. Legacy keys must have the
Supabase HS256/JWT shape, the `anon` role, Supabase issuer, and ordered issuance/
expiry claims; arbitrary user JWTs and service-role keys are rejected. This is
configuration screening, not signature verification: Supabase validates the key.
Modern secret keys and URLs containing credentials are rejected. All browser
configuration is public; missing/invalid configuration fails without echoing values.

```powershell
corepack pnpm --filter @cal-calc/web dev
```

The current backend has an app factory, not a running HTTP listener. This slice
does **not** add a server, proxy, or CORS policy. Creation requires a future
reachable, browser-compatible API; local Vite alone does not provide one.

## Behavior

Sign in with an existing account; no signup/reset/profile features. Supabase owns
normal browser session storage and refresh. Redux keeps a minimal in-memory
session view, auth progress/errors, creation state, and a pending command/key.
Redux DevTools are disabled; passwords never enter Redux. Session subjects only
clear client state on account changes, never authorize API calls. API requests
send Bearer credentials, not a user ID. Only the backend verifies authority.

Targets stay strings. Empty optional date/timezone fields become null; validation
and normalization remain server-owned. Results display authoritative CREATED or
REPLAYED state, not a client-calculated day. Multiple days with the same date are
allowed by the contract.

A new explicit submission gets `crypto.randomUUID()`. Network failures, server
failures, and malformed successful responses leave the outcome uncertain. The
form holds the exact command and key until the user explicitly retries; no
automatic retries or permanent retry storage. Confirmed success releases the
attempt so another submit gets a fresh key. Reload/sign-out/account change loses
the in-memory attempt; it does not undo a possibly committed request. Do not
interpret a new submission afterward as a safe retry of that lost attempt.

Account changes discard prior results and ignore late responses; same-account
token refresh preserves pending intent. Errors use fixed local messages, not raw
SDK/server text. No claim of browser-to-PostgreSQL end-to-end execution is made.

## Validate

```powershell
corepack pnpm --filter @cal-calc/web test
corepack pnpm --filter @cal-calc/web typecheck
corepack pnpm --filter @cal-calc/web lint
corepack pnpm --filter @cal-calc/web build
```

Build/dev require the public configuration above. Placeholder public values can
be used for a compilation-only build, but do not establish working authentication
or an available API. The two workspace `allowBuilds: false` entries suppress
optional Jest native dependency install scripts; their prebuilt packages are used.

Jest uses jsdom and Babel's TypeScript/React transform; `tsc` separately checks
types. React Testing Library and user-event exercise real React, Redux, and the
HTTP adapter with mocked Supabase auth and fetch boundaries. Tests cover auth,
wire payloads, exact strings, loading/error/result UI, retry identity, session
changes, and public configuration. They do not run host Supabase/PostgreSQL.
Root checks naturally include this workspace; backend tests remain on Vitest.

Deleting `apps/web` and its dependency/lockfile entries leaves the core backend,
domain, persistence, schema, and authentication architecture unchanged.
