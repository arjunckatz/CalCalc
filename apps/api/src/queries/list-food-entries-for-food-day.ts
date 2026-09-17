import type { FoodDay, FoodEntry } from "@cal-calc/domain";
import {
  FoodDayNotFoundError,
  type PostgresFoodDayRepository,
  type PostgresFoodEntryRepository,
} from "@cal-calc/persistence";

export interface ListFoodEntriesForFoodDayInput {
  readonly trustedUserId: string;
  readonly foodDayId: string;
}

export interface ListFoodEntriesForFoodDayResult {
  readonly foodDay: FoodDay;
  readonly entries: FoodEntry[];
}

export interface ListFoodEntriesForFoodDayDependencies {
  readonly foodDays: Pick<PostgresFoodDayRepository, "findById">;
  readonly foodEntries: Pick<
    PostgresFoodEntryRepository,
    "listActiveByFoodDay"
  >;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidFoodDayIdError extends Error {
  override readonly name = "InvalidFoodDayIdError";

  constructor() {
    super("Food day ID must be a UUID.");
  }
}

export async function listFoodEntriesForFoodDay(
  dependencies: ListFoodEntriesForFoodDayDependencies,
  input: ListFoodEntriesForFoodDayInput,
): Promise<ListFoodEntriesForFoodDayResult> {
  const { foodDayId, trustedUserId } = input;
  if (
    typeof foodDayId !== "string" ||
    foodDayId.length !== 36 ||
    !uuidPattern.test(foodDayId)
  ) {
    throw new InvalidFoodDayIdError();
  }
  const found = await dependencies.foodDays.findById(trustedUserId, foodDayId);
  if (found === null) throw new FoodDayNotFoundError(foodDayId);
  const entries = await dependencies.foodEntries.listActiveByFoodDay(
    trustedUserId,
    foodDayId,
  );
  return { foodDay: found.foodDay, entries };
}
