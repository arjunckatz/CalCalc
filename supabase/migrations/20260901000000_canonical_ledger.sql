create type public.food_entry_status as enum (
  'CONFIRMED_CONSUMED',
  'PLANNED',
  'CONSIDERED',
  'DISCARDED'
);

create type public.food_day_status as enum ('OPEN', 'CLOSED', 'PROVISIONAL');
create type public.food_day_completeness as enum (
  'UNKNOWN',
  'PARTIAL',
  'USER_DECLARED_COMPLETE'
);
create type public.evidence_class as enum ('EXACT', 'SOURCED', 'ESTIMATED');
create type public.measurement_unit as enum (
  'GRAM',
  'MILLILITRE',
  'SERVING',
  'CONTAINER'
);
create type public.consumed_time_precision as enum ('EXACT', 'APPROXIMATE');
create type public.semantic_operation_status as enum (
  'PENDING',
  'SUCCEEDED',
  'FAILED'
);

create function public.is_nutrition_json(
  value jsonb,
  require_calories boolean default true
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    case
      when jsonb_typeof(value) <> 'object' then false
      else
        (not require_calories or jsonb_typeof(value -> 'calories') = 'string')
        and (require_calories or value <> '{}'::jsonb)
        and not exists (
          select 1
          from jsonb_each(value) as nutrient
          where nutrient.key not in ('calories', 'protein', 'carbs', 'fat', 'fibre', 'sodium')
            or jsonb_typeof(nutrient.value) <> 'string'
            -- Matches the non-negative fixed-decimal output of M1 normalizeDecimal().
            or (nutrient.value #>> '{}') !~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'
        )
    end;
$$;

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function public.reject_revision_history_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'food entry revision history is append-only';
end;
$$;

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.food_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  status public.food_day_status not null,
  completeness public.food_day_completeness not null default 'UNKNOWN',
  calorie_target numeric not null check (calorie_target >= 0),
  protein_target numeric not null check (protein_target >= 0),
  maintenance_snapshot numeric check (maintenance_snapshot >= 0),
  goal_version_id text check (goal_version_id is null or btrim(goal_version_id) <> ''),
  local_date date,
  timezone text check (timezone is null or btrim(timezone) <> ''),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check (closed_at is null or closed_at >= opened_at)
);

create table public.semantic_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  operation_key text not null check (btrim(operation_key) <> ''),
  request_fingerprint text not null check (btrim(request_fingerprint) <> ''),
  status public.semantic_operation_status not null default 'PENDING',
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, operation_key),
  unique (id, user_id),
  check (result is null or jsonb_typeof(result) = 'object'),
  check (error is null or jsonb_typeof(error) = 'object'),
  check (completed_at is null or completed_at >= created_at),
  check (
    (
      status = 'PENDING'
      and completed_at is null
      and result is null
      and error is null
    )
    or (
      status = 'SUCCEEDED'
      and completed_at is not null
      and result is not null
      and jsonb_typeof(result) = 'object'
      and error is null
    )
    or (
      status = 'FAILED'
      and completed_at is not null
      and result is null
      and error is not null
      and jsonb_typeof(error) = 'object'
    )
  )
);

create table public.food_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  food_day_id uuid not null,
  raw_user_description text not null check (btrim(raw_user_description) <> ''),
  display_name text not null check (btrim(display_name) <> ''),
  normalized_name text check (normalized_name is null or btrim(normalized_name) <> ''),
  brand text check (brand is null or btrim(brand) <> ''),
  quantity_amount numeric not null check (quantity_amount > 0),
  quantity_unit public.measurement_unit not null,
  nutrition_basis_amount numeric not null check (nutrition_basis_amount > 0),
  nutrition_basis_unit public.measurement_unit not null,
  nutrition_basis jsonb not null,
  derived_nutrition jsonb not null,
  working_nutrition_override jsonb,
  working_nutrition jsonb not null,
  evidence_class public.evidence_class not null,
  estimate_low jsonb,
  estimate_high jsonb,
  status public.food_entry_status not null,
  revision integer not null check (revision >= 1),
  reported_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_time_precision public.consumed_time_precision,
  deleted_at timestamptz,
  last_operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (food_day_id, user_id)
    references public.food_days (id, user_id) on delete restrict,
  foreign key (last_operation_id, user_id)
    references public.semantic_operations (id, user_id) on delete restrict,
  check (quantity_unit = nutrition_basis_unit),
  check (public.is_nutrition_json(nutrition_basis)),
  check (public.is_nutrition_json(derived_nutrition)),
  check (public.is_nutrition_json(working_nutrition)),
  check (
    working_nutrition_override is null
    or public.is_nutrition_json(working_nutrition_override, false)
  ),
  check (estimate_low is null or public.is_nutrition_json(estimate_low)),
  check (estimate_high is null or public.is_nutrition_json(estimate_high)),
  check ((estimate_low is null) = (estimate_high is null)),
  check (
    (evidence_class = 'ESTIMATED')
    or (estimate_low is null and estimate_high is null)
  ),
  check ((consumed_at is null) = (consumed_time_precision is null))
);

create table public.food_entry_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  food_entry_id uuid not null,
  revision integer not null check (revision >= 1),
  operation_id uuid,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (food_entry_id, revision),
  foreign key (food_entry_id, user_id)
    references public.food_entries (id, user_id) on delete restrict,
  foreign key (operation_id, user_id)
    references public.semantic_operations (id, user_id) on delete restrict
);

create function public.enforce_food_entry_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 then
      raise exception 'new food entries must begin at revision 1';
    end if;
    if new.deleted_at is not null then
      raise exception 'new food entries must not be deleted';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.user_id <> old.user_id then
    raise exception 'food entry identity and ownership are immutable';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'food entry revision must increment exactly once';
  end if;
  return new;
end;
$$;

create function public.enforce_semantic_operation_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.operation_key is distinct from old.operation_key
    or new.request_fingerprint is distinct from old.request_fingerprint
    or new.created_at is distinct from old.created_at then
    raise exception 'semantic operation identity is immutable';
  end if;
  if old.status in ('SUCCEEDED', 'FAILED') then
    raise exception 'terminal semantic operations are immutable';
  end if;
  return new;
end;
$$;

create function public.capture_food_entry_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.food_entry_revisions (
    user_id,
    food_entry_id,
    revision,
    operation_id,
    snapshot,
    created_at
  ) values (
    new.user_id,
    new.id,
    new.revision,
    new.last_operation_id,
    to_jsonb(new) || jsonb_build_object(
      'quantity_amount', new.quantity_amount::text,
      'nutrition_basis_amount', new.nutrition_basis_amount::text
    ),
    now()
  );
  return new;
end;
$$;

create index food_days_user_opened_at_idx
  on public.food_days (user_id, opened_at desc);
create index food_entries_user_food_day_idx
  on public.food_entries (user_id, food_day_id)
  where deleted_at is null;
create index food_entries_user_reported_at_idx
  on public.food_entries (user_id, reported_at desc);
create index food_entry_revisions_entry_created_idx
  on public.food_entry_revisions (food_entry_id, created_at desc);
create index semantic_operations_user_created_idx
  on public.semantic_operations (user_id, created_at desc);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();
create trigger food_days_set_updated_at
before update on public.food_days
for each row execute function public.set_updated_at();
create trigger food_entries_set_updated_at
before update on public.food_entries
for each row execute function public.set_updated_at();
create trigger food_entries_enforce_revision
before insert or update on public.food_entries
for each row execute function public.enforce_food_entry_revision();
create trigger food_entries_capture_revision
after insert or update on public.food_entries
for each row execute function public.capture_food_entry_revision();
create trigger semantic_operations_set_updated_at
before update on public.semantic_operations
for each row execute function public.set_updated_at();
create trigger semantic_operations_enforce_update
before update on public.semantic_operations
for each row execute function public.enforce_semantic_operation_update();
create trigger food_entry_revisions_reject_update
before update on public.food_entry_revisions
for each row execute function public.reject_revision_history_update();

-- Authenticated users have no revision DELETE policy. DELETE is intentionally
-- not rejected by a trigger so a future privileged privacy purge can remove it.

alter table public.profiles enable row level security;
alter table public.food_days enable row level security;
alter table public.food_entries enable row level security;
alter table public.food_entry_revisions enable row level security;
alter table public.semantic_operations enable row level security;

create policy profiles_select_own on public.profiles
for select using ((select auth.uid()) = user_id);
create policy profiles_insert_own on public.profiles
for insert with check ((select auth.uid()) = user_id);
create policy profiles_update_own on public.profiles
for update using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy food_days_select_own on public.food_days
for select using ((select auth.uid()) = user_id);
create policy food_days_insert_own on public.food_days
for insert with check ((select auth.uid()) = user_id);
create policy food_days_update_own on public.food_days
for update using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy food_entries_select_own on public.food_entries
for select using ((select auth.uid()) = user_id);
create policy food_entries_insert_own on public.food_entries
for insert with check ((select auth.uid()) = user_id);
create policy food_entries_update_own on public.food_entries
for update using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy food_entry_revisions_select_own on public.food_entry_revisions
for select using ((select auth.uid()) = user_id);

create policy semantic_operations_select_own on public.semantic_operations
for select using ((select auth.uid()) = user_id);
create policy semantic_operations_insert_own on public.semantic_operations
for insert with check ((select auth.uid()) = user_id);
create policy semantic_operations_update_own on public.semantic_operations
for update using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
