-- Changing a function used by CHECK constraints does not revalidate stored rows.
-- Re-add the affected constraints so missing calories fail the migration too.
alter table public.food_entries
  drop constraint food_entries_nutrition_basis_check,
  drop constraint food_entries_derived_nutrition_check,
  drop constraint food_entries_working_nutrition_check,
  drop constraint food_entries_estimate_low_check,
  drop constraint food_entries_estimate_high_check;

create or replace function public.is_nutrition_json(
  value jsonb,
  require_calories boolean default true
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    case
      when jsonb_typeof(value) <> 'object' then false
      else
        (not require_calories or (jsonb_typeof(value -> 'calories') = 'string') is true)
        and (require_calories or value <> '{}'::jsonb)
        and not exists (
          select 1
          from jsonb_each(value) as nutrient
          where nutrient.key not in ('calories', 'protein', 'carbs', 'fat', 'fibre', 'sodium')
            or jsonb_typeof(nutrient.value) <> 'string'
            -- Matches the non-negative fixed-decimal output of M1 normalizeDecimal().
            or (nutrient.value #>> '{}') !~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'
        )
    end;
$$;

alter table public.food_entries
  add constraint food_entries_nutrition_basis_check
    check (public.is_nutrition_json(nutrition_basis)),
  add constraint food_entries_derived_nutrition_check
    check (public.is_nutrition_json(derived_nutrition)),
  add constraint food_entries_working_nutrition_check
    check (public.is_nutrition_json(working_nutrition)),
  add constraint food_entries_estimate_low_check
    check (estimate_low is null or public.is_nutrition_json(estimate_low)),
  add constraint food_entries_estimate_high_check
    check (estimate_high is null or public.is_nutrition_json(estimate_high));
