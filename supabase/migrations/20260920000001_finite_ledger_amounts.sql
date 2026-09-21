-- PostgreSQL numeric NaN sorts above Infinity, so lower bounds alone accept both.
-- Keep the existing zero/positive rules and add a finite upper bound. Re-adding
-- these constraints also validates all existing rows without rewriting them.
alter table public.food_days
  drop constraint food_days_calorie_target_check,
  drop constraint food_days_protein_target_check,
  drop constraint food_days_maintenance_snapshot_check,
  add constraint food_days_calorie_target_check
    check (calorie_target >= 0 and calorie_target < 'Infinity'::numeric),
  add constraint food_days_protein_target_check
    check (protein_target >= 0 and protein_target < 'Infinity'::numeric),
  add constraint food_days_maintenance_snapshot_check
    check (maintenance_snapshot >= 0 and maintenance_snapshot < 'Infinity'::numeric);

alter table public.food_entries
  drop constraint food_entries_quantity_amount_check,
  drop constraint food_entries_nutrition_basis_amount_check,
  add constraint food_entries_quantity_amount_check
    check (quantity_amount > 0 and quantity_amount < 'Infinity'::numeric),
  add constraint food_entries_nutrition_basis_amount_check
    check (nutrition_basis_amount > 0 and nutrition_basis_amount < 'Infinity'::numeric);
