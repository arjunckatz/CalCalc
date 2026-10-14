-- Owner-scoped exact local-date candidates in deterministic order.
create index food_days_user_local_date_opened_id_idx
  on public.food_days (user_id, local_date, opened_at, id);
