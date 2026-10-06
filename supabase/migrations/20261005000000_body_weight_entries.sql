create type public.body_weight_unit as enum ('KG', 'LB');

create table public.body_weight_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  local_date date not null,
  source_value numeric not null,
  source_unit public.body_weight_unit not null,
  weight_kg numeric not null,
  created_at timestamptz not null default now(),
  constraint body_weight_entries_source_value_positive_finite
    check (source_value > 0 and source_value < 'Infinity'::numeric),
  constraint body_weight_entries_weight_kg_positive_finite
    check (weight_kg > 0 and weight_kg < 'Infinity'::numeric),
  constraint body_weight_entries_exact_conversion
    check (
      weight_kg = case source_unit
        when 'KG' then source_value
        when 'LB' then source_value * 0.45359237::numeric
      end
    )
);

-- Multiple observations on the same local date are intentionally allowed.
create index body_weight_entries_user_recent_idx
  on public.body_weight_entries (user_id, local_date desc, created_at desc, id desc);

alter table public.body_weight_entries enable row level security;

create policy body_weight_entries_select_own on public.body_weight_entries
for select using ((select auth.uid()) = user_id);
create policy body_weight_entries_insert_own on public.body_weight_entries
for insert with check ((select auth.uid()) = user_id);

-- No authenticated UPDATE or DELETE policy: M4D5A is create-only.
