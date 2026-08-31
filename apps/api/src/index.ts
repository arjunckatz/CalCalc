import { environmentVariableNames } from "@cal-calc/config";
import { domainBoundary } from "@cal-calc/domain";
import type { NonEmptyArray } from "@cal-calc/shared";

export function describeFoundation(): NonEmptyArray<string> {
  return [domainBoundary, environmentVariableNames.supabaseUrl];
}
