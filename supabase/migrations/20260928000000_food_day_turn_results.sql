create table public.food_day_turn_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  food_day_id uuid not null,
  turn_key text not null check (btrim(turn_key) <> ''),
  request_fingerprint text not null check (btrim(request_fingerprint) <> ''),
  response text not null check (btrim(response) <> ''),
  created_at timestamptz not null default now(),
  unique (user_id, turn_key),
  foreign key (food_day_id, user_id)
    references public.food_days (id, user_id) on delete restrict
);

create function public.reject_food_day_turn_result_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'completed FoodDay turn results are immutable';
end;
$$;

create trigger food_day_turn_results_reject_update
before update on public.food_day_turn_results
for each row execute function public.reject_food_day_turn_result_update();

alter table public.food_day_turn_results enable row level security;

create policy food_day_turn_results_select_own
on public.food_day_turn_results
for select using ((select auth.uid()) = user_id);

-- Completed turn results are application-owned. Authenticated clients receive
-- no INSERT, UPDATE, or DELETE policy; the server persists them through its
-- trusted PostgreSQL runtime. A privileged future privacy purge may delete them.
