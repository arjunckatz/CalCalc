create table public.conversations (
  user_id uuid primary key references auth.users (id) on delete restrict,
  active_food_day_id uuid,
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (active_food_day_id, user_id)
    references public.food_days (id, user_id) on delete restrict
);

create function public.enforce_conversation_pointer_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.active_food_day_id is not null or new.version <> 0 then
      raise exception 'new conversations begin without an active FoodDay';
    end if;
    new.created_at = clock_timestamp();
    new.updated_at = new.created_at;
    return new;
  end if;
  if new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at
    or new.version <> old.version + 1
    or new.active_food_day_id is not distinct from old.active_food_day_id then
    raise exception 'conversation pointer update requires one version step';
  end if;
  return new;
end;
$$;

create trigger conversations_enforce_pointer_update
before insert or update on public.conversations
for each row execute function public.enforce_conversation_pointer_update();

create trigger conversations_set_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

create table public.conversation_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.conversations (user_id) on delete restrict,
  turn_key text not null check (btrim(turn_key) <> ''),
  request_fingerprint text not null check (btrim(request_fingerprint) <> ''),
  user_message text not null check (btrim(user_message) <> ''),
  calendar_context jsonb not null default 'null'::jsonb
    check (jsonb_typeof(calendar_context) in ('null', 'object')),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'COMPLETED')),
  resolved_food_day_id uuid,
  execution_plan jsonb check (
    execution_plan is null or
    case when jsonb_typeof(execution_plan -> 'slots') = 'array' then
      execution_plan ->> 'schema' = 'account-turn-plan-v1'
      and jsonb_array_length(execution_plan -> 'slots') between 1 and 8
    else false end
  ),
  response text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (user_id, turn_key),
  foreign key (resolved_food_day_id, user_id)
    references public.food_days (id, user_id) on delete restrict,
  check (
    (status = 'PENDING' and response is null and completed_at is null)
    or
    (status = 'COMPLETED' and response is not null
      and btrim(response) <> '' and completed_at is not null)
  )
);

create function public.enforce_conversation_turn_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING'
      or new.resolved_food_day_id is not null
      or new.execution_plan is not null
      or new.response is not null
      or new.completed_at is not null then
      raise exception 'new conversation turns must begin pending';
    end if;
    new.created_at = clock_timestamp();
    return new;
  end if;
  if old.status = 'COMPLETED' then
    raise exception 'completed conversation turns are immutable';
  end if;
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.turn_key is distinct from old.turn_key
    or new.request_fingerprint is distinct from old.request_fingerprint
    or new.user_message is distinct from old.user_message
    or new.calendar_context is distinct from old.calendar_context
    or new.created_at is distinct from old.created_at then
    raise exception 'conversation turn identity is immutable';
  end if;
  if old.resolved_food_day_id is not null
    and new.resolved_food_day_id is distinct from old.resolved_food_day_id then
    raise exception 'resolved conversation target is immutable';
  end if;
  if old.execution_plan is not null then
    if new.execution_plan is distinct from old.execution_plan then
      raise exception 'conversation execution plan is immutable';
    end if;
    if new.resolved_food_day_id is distinct from old.resolved_food_day_id then
      raise exception 'planned conversation target is immutable';
    end if;
  end if;
  if new.status = 'COMPLETED' then
    new.completed_at = clock_timestamp();
  elsif new.completed_at is distinct from old.completed_at then
    raise exception 'pending conversation completion time is immutable';
  end if;
  return new;
end;
$$;

create trigger conversation_turns_enforce_update
before insert or update on public.conversation_turns
for each row execute function public.enforce_conversation_turn_update();

create index conversation_turns_recent_completed_idx
on public.conversation_turns (user_id, created_at desc, id desc)
where status = 'COMPLETED';

alter table public.conversations enable row level security;
alter table public.conversation_turns enable row level security;

-- The trusted application PostgreSQL runtime owns this internal state. No
-- direct-client RLS policy or table grant is added for anon/authenticated.
revoke all on public.conversations from anon, authenticated;
revoke all on public.conversation_turns from anon, authenticated;
