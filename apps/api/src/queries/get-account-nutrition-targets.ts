import type {
  AccountNutritionTargets,
  PostgresAccountNutritionTargetsRepository,
} from "@cal-calc/persistence";

export type GetAccountNutritionTargetsResult =
  | { readonly kind: "NOT_CONFIGURED" }
  | { readonly kind: "CONFIGURED"; readonly targets: AccountNutritionTargets };

/** Account-scoped defaults only; absence never implies zero or historical inheritance. */
export async function getAccountNutritionTargets(
  dependencies: {
    readonly targets: Pick<
      PostgresAccountNutritionTargetsRepository,
      "findByUser"
    >;
  },
  input: { readonly trustedUserId: string },
): Promise<GetAccountNutritionTargetsResult> {
  const targets = await dependencies.targets.findByUser(input.trustedUserId);
  return targets === null
    ? { kind: "NOT_CONFIGURED" }
    : { kind: "CONFIGURED", targets };
}
