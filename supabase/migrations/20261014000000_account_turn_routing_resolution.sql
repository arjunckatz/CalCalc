alter table public.conversation_turns
  add column routing_resolution jsonb,
  add constraint conversation_turns_routing_resolution_object_check
    check (routing_resolution is null or jsonb_typeof(routing_resolution) = 'object'),
  add constraint conversation_turns_routing_resolution_target_check
    check (
      routing_resolution is null or
      case when routing_resolution ->> 'kind' in
        ('EXISTING_DAY', 'EXISTING_ENTRY_REFERENCE') then
          resolved_food_day_id is not null
          and coalesce(
            routing_resolution ->> 'foodDayId' = resolved_food_day_id::text,
            false
          )
      else resolved_food_day_id is null end
    );

create or replace function public.enforce_conversation_turn_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING'
      or new.resolved_food_day_id is not null
      or new.routing_resolution is not null
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
  if old.routing_resolution is not null
    and new.routing_resolution is distinct from old.routing_resolution then
    raise exception 'conversation routing resolution is immutable';
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

-- The field remains server-owned under the existing table RLS and grants.
