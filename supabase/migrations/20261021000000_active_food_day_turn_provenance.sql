alter table public.conversations
  add column active_food_day_turn_id uuid,
  add constraint conversations_active_food_day_turn_owner_fk
    foreign key (active_food_day_turn_id, user_id)
    references public.conversation_turns (id, user_id) on delete restrict;

create or replace function public.enforce_conversation_pointer_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  source_created_at timestamptz;
  previous_created_at timestamptz;
  source_target uuid;
  source_status text;
begin
  if tg_op = 'INSERT' then
    if new.active_food_day_id is not null
      or new.active_food_day_turn_id is not null
      or new.version <> 0 then
      raise exception 'new conversations begin without an active FoodDay';
    end if;
    new.created_at = clock_timestamp();
    new.updated_at = new.created_at;
    return new;
  end if;
  if new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at
    or new.version <> old.version + 1
    or (new.active_food_day_id is not distinct from old.active_food_day_id
      and new.active_food_day_turn_id is not distinct from old.active_food_day_turn_id) then
    raise exception 'conversation pointer update requires one version step';
  end if;
  if new.active_food_day_turn_id is not null then
    select t.created_at, (t.execution_plan ->> 'foodDayId')::uuid, t.status
      into source_created_at, source_target, source_status
      from public.conversation_turns t
      where t.id = new.active_food_day_turn_id and t.user_id = new.user_id;
    if not found or source_status <> 'COMPLETED'
      or source_target is distinct from new.active_food_day_id then
      raise exception 'active FoodDay source must be a completed owned target';
    end if;
    if not exists (
      select 1 from public.account_turn_step_results r
      join public.conversation_turns t
        on t.id = r.turn_id and t.user_id = r.user_id
      where t.id = new.active_food_day_turn_id and t.user_id = new.user_id
        and r.result ->> 'schema' = 'account-turn-step-result-v1'
        and r.result ->> 'action' =
          t.execution_plan -> 'slots' -> r.ordinal ->> 'action'
        and jsonb_typeof(r.result -> 'outcome') = 'object'
        and r.result ->> 'action' in (
          'LOG_FOOD', 'UPDATE_FOOD_QUANTITY', 'REMOVE_FOOD',
          'CHANGE_FOOD_STATUS', 'SET_FOOD_DAY_COMPLETENESS'
        )
    ) then
      raise exception 'active FoodDay source requires a food mutation checkpoint';
    end if;
    if old.active_food_day_turn_id is not null then
      select t.created_at into previous_created_at
        from public.conversation_turns t
        where t.id = old.active_food_day_turn_id and t.user_id = new.user_id;
      if not found or (source_created_at, new.active_food_day_turn_id)
          <= (previous_created_at, old.active_food_day_turn_id) then
        raise exception 'active FoodDay source cannot move backward';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- Existing server-owned grants/RLS remain unchanged. No index is needed:
-- the conversation row is owner-keyed and source turns use their primary key.
