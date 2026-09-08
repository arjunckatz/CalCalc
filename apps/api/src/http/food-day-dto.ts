import type { PersistedFoodDay } from "@cal-calc/persistence";

export interface FoodDayDto {
  readonly id: string;
  readonly status: PersistedFoodDay["foodDay"]["status"];
  readonly completeness: PersistedFoodDay["completeness"];
  readonly calorieTarget: string;
  readonly proteinTarget: string;
  readonly localDate: string | null;
  readonly timezone: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toFoodDayDto(persisted: PersistedFoodDay): FoodDayDto {
  return {
    id: persisted.foodDay.id,
    status: persisted.foodDay.status,
    completeness: persisted.completeness,
    calorieTarget: persisted.foodDay.calorieTarget,
    proteinTarget: persisted.foodDay.proteinTarget,
    localDate: persisted.localDate ?? null,
    timezone: persisted.timezone ?? null,
    openedAt: persisted.openedAt,
    closedAt: persisted.closedAt ?? null,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
  };
}
