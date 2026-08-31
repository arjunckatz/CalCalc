# CAL CALC

CAL CALC is an AI-native conversational calorie and weight tracker. Conversation is the primary interface, while deterministic domain code owns calculations and ledger behavior and PostgreSQL remains the canonical historical source of truth.

## Repository structure

- `apps/api` — minimal Node.js TypeScript application package
- `packages/domain` — framework-independent business and domain logic
- `packages/shared` — small cross-cutting TypeScript types and utilities
- `packages/config` — shared project configuration helpers
- `supabase` — local Supabase configuration and future version-controlled migrations

## Prerequisites

- Node.js 24 or newer
- Corepack (included with the detected Node.js installation) or pnpm 11.24.0
- A Docker-compatible runtime to run the full local Supabase stack

## Install and validate

```sh
corepack pnpm install
corepack pnpm check
```

The `packageManager` field pins the pnpm release used by Corepack. If pnpm is installed directly, `pnpm install` and `pnpm check` are equivalent.

## Supabase local development

The official Supabase CLI is installed as a project development dependency. The repository has been initialized with its standard local configuration. Once Docker is running, start and stop the local services with:

```sh
corepack pnpm supabase:start
corepack pnpm supabase:stop
```

Full local Supabase services require a Docker-compatible runtime. Schema changes belong in version-controlled migrations; do not create application tables manually in a hosted dashboard.

## Environment files

Copy `.env.example` to `.env` for local values. `.env` files are ignored by Git. Publishable Supabase client values and server-only credentials are documented separately in the example; never expose the service-role key or OpenAI API key to a client.
