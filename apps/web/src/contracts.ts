/** Public HTTP wire types only; the backend owns all domain validation. */
export interface CreateFoodDayCommand {
  calorieTarget: string;
  proteinTarget: string;
  localDate?: string | null;
  timezone?: string | null;
}

export interface FoodDayDto {
  id: string;
  status: "OPEN" | "PROVISIONAL" | "CLOSED";
  completeness: "UNKNOWN" | "PARTIAL" | "USER_DECLARED_COMPLETE";
  calorieTarget: string;
  proteinTarget: string;
  localDate: string | null;
  timezone: string | null;
  openedAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFoodDayResult {
  disposition: "CREATED" | "REPLAYED";
  foodDay: FoodDayDto;
}

export interface ClientError {
  kind: "network" | "validation" | "unauthenticated" | "conflict" | "server";
  message: string;
  retryable: boolean;
}
