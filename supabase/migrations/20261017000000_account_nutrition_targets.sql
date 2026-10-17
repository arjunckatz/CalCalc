create table public.account_nutrition_targets (
  user_id uuid primary key references auth.users (id) on delete restrict,
  calorie_target numeric not null check (
    calorie_target >= 0
    and calorie_target::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  protein_target numeric not null check (
    protein_target >= 0
    and protein_target::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create function public.enforce_account_nutrition_targets_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.version <> 0 then
      raise exception 'new account targets must begin at version zero';
    end if;
    new.created_at = clock_timestamp();
    new.updated_at = new.created_at;
    return new;
  end if;
  if new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at
    or old.version = 2147483647
    or new.version <> old.version + 1 then
    raise exception 'account target update requires one version step';
  end if;
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

create trigger account_nutrition_targets_enforce_change
before insert or update on public.account_nutrition_targets
for each row execute function public.enforce_account_nutrition_targets_change();

alter table public.account_nutrition_targets enable row level security;

-- The trusted application runtime owns configuration writes. Browser roles
-- receive no direct table access; a future authenticated endpoint can use the
-- application mutation without changing this boundary.
revoke all on public.account_nutrition_targets from anon, authenticated;
