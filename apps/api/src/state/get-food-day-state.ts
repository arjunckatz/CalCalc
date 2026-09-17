import type {
  ListFoodEntriesForFoodDayDependencies,
  ListFoodEntriesForFoodDayInput,
} from "../queries/list-food-entries-for-food-day.js";
import { listFoodEntriesForFoodDay } from "../queries/list-food-entries-for-food-day.js";
import {
  buildFoodDayState,
  type FoodDayState,
} from "./build-food-day-state.js";

export async function getFoodDayState(
  dependencies: ListFoodEntriesForFoodDayDependencies,
  input: ListFoodEntriesForFoodDayInput,
): Promise<FoodDayState> {
  return buildFoodDayState(
    await listFoodEntriesForFoodDay(dependencies, input),
  );
}
