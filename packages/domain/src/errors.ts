export class DomainValidationError extends Error {
  readonly code = "DOMAIN_VALIDATION_ERROR" as const;

  constructor(
    message: string,
    readonly issues: readonly string[] = [message],
  ) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export class IncompatibleUnitError extends Error {
  readonly code = "INCOMPATIBLE_UNIT" as const;

  constructor(
    readonly basisUnit: string,
    readonly quantityUnit: string,
  ) {
    super(`Cannot calculate ${quantityUnit} from a ${basisUnit} basis.`);
    this.name = "IncompatibleUnitError";
  }
}

export interface RevisionConflict {
  readonly type: "REVISION_CONFLICT";
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
}

export type MutationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: RevisionConflict };
