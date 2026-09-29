create index food_day_turn_results_recent_transcript_idx
on public.food_day_turn_results (
  user_id,
  food_day_id,
  created_at desc,
  id desc
)
where user_message is not null;

comment on index public.food_day_turn_results_recent_transcript_idx is
  'Supports bounded newest-first selection of non-legacy FoodDay transcript pairs.';
