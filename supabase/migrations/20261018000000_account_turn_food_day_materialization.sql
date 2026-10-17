alter table public.conversation_turns
  add column materialized_food_day_id uuid,
  add constraint conversation_turns_materialized_food_day_owner_fk
    foreign key (materialized_food_day_id, user_id)
    references public.food_days (id, user_id) on delete restrict,
  add constraint conversation_turns_materialized_food_day_resolution_check
    check (
      materialized_food_day_id is null or
      coalesce(routing_resolution ->> 'kind' = 'DATE_TARGET', false)
    );

create function public.enforce_conversation_turn_materialization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.materialized_food_day_id is not null then
      raise exception 'new conversation turns cannot have a materialized FoodDay';
    end if;
    return new;
  end if;
  if old.materialized_food_day_id is not null
    and new.materialized_food_day_id is distinct from old.materialized_food_day_id then
    raise exception 'materialized FoodDay target is immutable';
  end if;
  if old.materialized_food_day_id is null
    and new.materialized_food_day_id is not null
    and (
      old.status <> 'PENDING'
      or old.routing_resolution ->> 'kind' is distinct from 'DATE_TARGET'
      or old.execution_plan is not null
    ) then
    raise exception 'materialization requires a pending resolved date target';
  end if;
  return new;
end;
$$;

create trigger conversation_turns_enforce_materialization
before insert or update on public.conversation_turns
for each row execute function public.enforce_conversation_turn_materialization();

-- conversation_turns remains server-owned under its existing RLS and grants.
