-- Execution outcomes are separate from the immutable account-turn plan.
alter table public.conversation_turns
  add constraint conversation_turns_id_user_unique unique (id, user_id);

create table public.account_turn_step_results (
  turn_id uuid not null,
  user_id uuid not null,
  ordinal smallint not null check (ordinal between 0 and 7),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (turn_id, ordinal),
  foreign key (turn_id, user_id)
    references public.conversation_turns (id, user_id) on delete cascade
);

create function public.enforce_account_turn_step_result_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_status text;
  parent_plan jsonb;
begin
  select status, execution_plan into parent_status, parent_plan
    from public.conversation_turns
    where id = new.turn_id and user_id = new.user_id
    for update;
  if not found or parent_status <> 'PENDING' or parent_plan is null
    or new.ordinal >= jsonb_array_length(parent_plan -> 'slots')
    or new.result ->> 'schema' is distinct from 'account-turn-step-result-v1'
    or new.result ->> 'action' is distinct from
      parent_plan -> 'slots' -> new.ordinal ->> 'action'
    or jsonb_typeof(new.result -> 'outcome') is distinct from 'object' then
    raise exception 'invalid account turn step checkpoint';
  end if;
  if new.ordinal > 0 and not exists (
    select 1 from public.account_turn_step_results
    where turn_id = new.turn_id and ordinal = new.ordinal - 1
  ) then
    raise exception 'account turn step checkpoints must be contiguous';
  end if;
  new.created_at = clock_timestamp();
  return new;
end;
$$;

create trigger account_turn_step_results_enforce_insert
before insert on public.account_turn_step_results
for each row execute function public.enforce_account_turn_step_result_insert();

create function public.reject_account_turn_step_result_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'account turn step results are append-only';
end;
$$;

create trigger account_turn_step_results_reject_update
before update on public.account_turn_step_results
for each row execute function public.reject_account_turn_step_result_update();

alter table public.account_turn_step_results enable row level security;
revoke all on public.account_turn_step_results from anon, authenticated;
-- Trusted application PostgreSQL runtime only; no direct-client policy.
