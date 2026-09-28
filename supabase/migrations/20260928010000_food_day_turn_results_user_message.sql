alter table public.food_day_turn_results
add column user_message text;

alter table public.food_day_turn_results
add constraint food_day_turn_results_user_message_nonblank
check (user_message is not null and btrim(user_message) <> '') not valid;

comment on column public.food_day_turn_results.user_message is
  'Exact accepted user message. NULL only for legacy rows created before transcript persistence.';
