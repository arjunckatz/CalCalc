import { environmentVariableNames } from "@cal-calc/config";
import { normalizeDecimal } from "@cal-calc/domain";
import type { NonEmptyArray } from "@cal-calc/shared";

export function describeFoundation(): NonEmptyArray<string> {
  return [normalizeDecimal("1"), environmentVariableNames.supabaseUrl];
}
