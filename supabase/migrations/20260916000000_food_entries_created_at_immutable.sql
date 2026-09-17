create or replace function public.enforce_food_entry_revision()
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
  if new.created_at is distinct from old.created_at then
    raise exception 'food entry creation timestamp is immutable';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'food entry revision must increment exactly once';
  end if;
  return new;
end;
$$;
