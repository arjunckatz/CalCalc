import type {
  ClientError,
  CreateFoodDayCommand,
  CreateFoodDayResult,
} from "./contracts";

export class ApiError extends Error {
  constructor(readonly detail: ClientError) {
    super(detail.message);
  }
}

export function createApiClient(
  baseUrl: string,
  request: typeof fetch = fetch,
) {
  return {
    async createFoodDay(
      command: CreateFoodDayCommand,
      token: string,
      key: string,
      signal?: AbortSignal,
    ): Promise<CreateFoodDayResult> {
      let response: Response;
      try {
        response = await request(
          `${baseUrl.replace(/\/+$/, "")}/v1/food-days`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              "Idempotency-Key": key,
            },
            body: JSON.stringify({
              calorieTarget: command.calorieTarget,
              proteinTarget: command.proteinTarget,
              localDate: command.localDate ?? null,
              timezone: command.timezone ?? null,
            }),
            ...(signal === undefined ? {} : { signal }),
            redirect: "error",
            credentials: "omit",
          },
        );
      } catch {
        throw new ApiError({
          kind: "network",
          message: "Could not confirm creation. Retry the same request safely.",
          retryable: true,
        });
      }
      if (response.status === 400)
        throw new ApiError({
          kind: "validation",
          message:
            "The request was rejected. Check the targets, date, and timezone.",
          retryable: false,
        });
      if (response.status === 401)
        throw new ApiError({
          kind: "unauthenticated",
          message: "Your session was rejected. Sign out and sign in again.",
          retryable: false,
        });
      if (response.status === 409)
        throw new ApiError({
          kind: "conflict",
          message:
            "Idempotency conflict: this request cannot be replayed. Do not change a pending request's meaning.",
          retryable: false,
        });
      if (response.status !== 200 && response.status !== 201) {
        throw new ApiError({
          kind: "server",
          message:
            "The server could not confirm creation. Retry the same request.",
          retryable: true,
        });
      }
      try {
        const body: unknown = await response.json();
        return parseResult(body, response.status);
      } catch {
        throw new ApiError({
          kind: "server",
          message:
            "An unexpected response left creation unconfirmed. Retry the same request.",
          retryable: true,
        });
      }
    },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;

function parseResult(value: unknown, status: number): CreateFoodDayResult {
  if (
    !record(value) ||
    value.disposition !== (status === 201 ? "CREATED" : "REPLAYED") ||
    !record(value.foodDay)
  )
    throw new Error("Invalid response.");
  const day = value.foodDay;
  for (const key of [
    "id",
    "calorieTarget",
    "proteinTarget",
    "openedAt",
    "createdAt",
    "updatedAt",
  ]) {
    if (typeof day[key] !== "string") throw new Error("Invalid response.");
  }
  for (const key of ["localDate", "timezone", "closedAt"]) {
    if (day[key] !== null && typeof day[key] !== "string")
      throw new Error("Invalid response.");
  }
  if (
    typeof day.status !== "string" ||
    !["OPEN", "PROVISIONAL", "CLOSED"].includes(day.status) ||
    typeof day.completeness !== "string" ||
    !["UNKNOWN", "PARTIAL", "USER_DECLARED_COMPLETE"].includes(day.completeness)
  )
    throw new Error("Invalid response.");
  // Pick only public fields, even if an unexpected server response includes extras.
  return {
    disposition: status === 201 ? "CREATED" : "REPLAYED",
    foodDay: {
      id: day.id as string,
      status: day.status as CreateFoodDayResult["foodDay"]["status"],
      completeness:
        day.completeness as CreateFoodDayResult["foodDay"]["completeness"],
      calorieTarget: day.calorieTarget as string,
      proteinTarget: day.proteinTarget as string,
      localDate: day.localDate as string | null,
      timezone: day.timezone as string | null,
      openedAt: day.openedAt as string,
      closedAt: day.closedAt as string | null,
      createdAt: day.createdAt as string,
      updatedAt: day.updatedAt as string,
    },
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
