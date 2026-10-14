import {
  acceptLocalDate,
  deriveCalendarFacts,
  previousCalendarDate,
  type AcceptedCalendarContext,
} from "./calendar-context.js";
import {
  RoutingCandidateNotFoundError,
  type ModelSafeRoutingContext,
  type RoutingSnapshot,
} from "./routing-context.js";

export type RawFoodDayTargetDecision =
  | { readonly kind: "EXISTING_DAY"; readonly dayToken: string }
  | { readonly kind: "EXISTING_ENTRY_REFERENCE"; readonly entryToken: string }
  | { readonly kind: "DATE_TARGET"; readonly localDate: string }
  | { readonly kind: "DAYLESS" }
  | { readonly kind: "CLARIFY"; readonly question: string };

export interface FoodDayTargetResolutionInput {
  readonly message: string;
  readonly calendarContext: AcceptedCalendarContext | null;
  readonly routing: ModelSafeRoutingContext;
}

export interface FoodDayTargetResolutionModel {
  decide(input: FoodDayTargetResolutionInput): Promise<unknown>;
}

/** Snapshot evidence only. A future mutation must recheck ownership, existence,
 * current revision, and domain preconditions; this result is not a lock. */
export type ValidatedFoodDayTarget =
  | { readonly kind: "EXISTING_DAY"; readonly foodDayId: string }
  | {
      readonly kind: "EXISTING_ENTRY_REFERENCE";
      readonly foodDayId: string;
      readonly entryId: string;
      readonly revision: number;
    }
  | { readonly kind: "DATE_TARGET"; readonly localDate: string }
  | { readonly kind: "DAYLESS" }
  | { readonly kind: "CLARIFY"; readonly question: string };

export type TargetResolutionErrorReason =
  | "INVALID_INPUT"
  | "INVALID_DECISION"
  | "UNKNOWN_DAY_TOKEN"
  | "UNKNOWN_ENTRY_TOKEN"
  | "INVALID_DATE_TARGET"
  | "INVALID_CLARIFICATION";

export class FoodDayTargetResolutionError extends Error {
  override readonly name = "FoodDayTargetResolutionError";
  constructor(readonly reason: TargetResolutionErrorReason) {
    super(`FoodDay target resolution failed: ${reason}.`);
  }
}

const ambiguousDayQuestion = "Which day log should I use for that date?";

/** No repository, transaction, tool, or STATE dependency. Exactly one model call. */
export async function resolveFoodDayTarget(
  model: FoodDayTargetResolutionModel,
  input: {
    readonly message: string;
    readonly calendarContext: AcceptedCalendarContext | null;
    readonly snapshot: RoutingSnapshot;
  },
): Promise<ValidatedFoodDayTarget> {
  if (
    typeof input.message !== "string" ||
    input.message.trim() === "" ||
    !sameCalendarContext(
      input.calendarContext,
      input.snapshot.projection.calendarContext,
    )
  ) {
    throw new FoodDayTargetResolutionError("INVALID_INPUT");
  }
  const raw = await model.decide({
    message: input.message,
    calendarContext: input.calendarContext,
    routing: input.snapshot.projection,
  });
  return validateFoodDayTargetDecision(raw, input);
}

export function validateFoodDayTargetDecision(
  raw: unknown,
  input: {
    readonly message: string;
    readonly calendarContext: AcceptedCalendarContext | null;
    readonly snapshot: RoutingSnapshot;
  },
): ValidatedFoodDayTarget {
  if (!plainRecord(raw)) {
    throw new FoodDayTargetResolutionError("INVALID_DECISION");
  }
  const kind = Object.getOwnPropertyDescriptor(raw, "kind");
  if (
    kind === undefined ||
    !("value" in kind) ||
    typeof kind.value !== "string"
  )
    throw new FoodDayTargetResolutionError("INVALID_DECISION");
  switch (kind.value) {
    case "EXISTING_DAY": {
      if (
        !exactKeys(raw, ["kind", "dayToken"]) ||
        typeof raw.dayToken !== "string"
      )
        throw new FoodDayTargetResolutionError("INVALID_DECISION");
      try {
        const day = input.snapshot.resolveDayToken(raw.dayToken);
        return applyRoutingAmbiguityPolicy(
          {
            kind: "EXISTING_DAY",
            dayToken: raw.dayToken,
            foodDayId: day.foodDayId,
          },
          input,
        );
      } catch (error) {
        if (error instanceof RoutingCandidateNotFoundError)
          throw new FoodDayTargetResolutionError("UNKNOWN_DAY_TOKEN");
        throw error;
      }
    }
    case "EXISTING_ENTRY_REFERENCE": {
      if (
        !exactKeys(raw, ["kind", "entryToken"]) ||
        typeof raw.entryToken !== "string"
      )
        throw new FoodDayTargetResolutionError("INVALID_DECISION");
      try {
        const entry = input.snapshot.resolveEntryToken(raw.entryToken);
        return {
          kind: "EXISTING_ENTRY_REFERENCE",
          foodDayId: entry.foodDayId,
          entryId: entry.entryId,
          revision: entry.revision,
        };
      } catch (error) {
        if (error instanceof RoutingCandidateNotFoundError)
          throw new FoodDayTargetResolutionError("UNKNOWN_ENTRY_TOKEN");
        throw error;
      }
    }
    case "DATE_TARGET": {
      if (
        !exactKeys(raw, ["kind", "localDate"]) ||
        typeof raw.localDate !== "string"
      )
        throw new FoodDayTargetResolutionError("INVALID_DECISION");
      try {
        acceptLocalDate(raw.localDate);
      } catch {
        throw new FoodDayTargetResolutionError("INVALID_DATE_TARGET");
      }
      const literalDates: readonly string[] =
        input.message.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g) ?? [];
      const literal = literalDates.includes(raw.localDate);
      const facts =
        input.calendarContext === null
          ? null
          : deriveCalendarFacts(input.calendarContext);
      const previous =
        facts === null || facts.localDate === "0001-01-01"
          ? null
          : previousCalendarDate(facts.localDate);
      const today =
        /\btoday\b|\bthis morning\b|\bthis afternoon\b|\bthis evening\b/i.test(
          input.message,
        );
      const yesterday = /\byesterday\b/i.test(input.message);
      const relative =
        facts !== null &&
        ((today && !yesterday && raw.localDate === facts.localDate) ||
          (yesterday && !today && raw.localDate === previous));
      if (
        (!literalDates.length && !relative) ||
        (literalDates.length > 0 && !literal)
      )
        throw new FoodDayTargetResolutionError("INVALID_DATE_TARGET");
      return applyRoutingAmbiguityPolicy(
        { kind: "DATE_TARGET", localDate: raw.localDate },
        input,
      );
    }
    case "DAYLESS":
      if (!exactKeys(raw, ["kind"]))
        throw new FoodDayTargetResolutionError("INVALID_DECISION");
      return { kind: "DAYLESS" };
    case "CLARIFY": {
      if (
        !exactKeys(raw, ["kind", "question"]) ||
        typeof raw.question !== "string"
      )
        throw new FoodDayTargetResolutionError("INVALID_DECISION");
      const question = raw.question.trim();
      if (
        question.length === 0 ||
        question.length > 240 ||
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
          question,
        ) ||
        /\b(?:day|entry)_[a-z0-9_]+\b/i.test(question)
      )
        throw new FoodDayTargetResolutionError("INVALID_CLARIFICATION");
      return { kind: "CLARIFY", question };
    }
    default:
      throw new FoodDayTargetResolutionError("INVALID_DECISION");
  }
}

/** Only a valid, snapshot-bound proposal reaches this policy. Ambiguity never
 * selects a canonical target, retries the model, or changes stored state. */
function applyRoutingAmbiguityPolicy(
  proposal:
    | {
        readonly kind: "EXISTING_DAY";
        readonly dayToken: string;
        readonly foodDayId: string;
      }
    | { readonly kind: "DATE_TARGET"; readonly localDate: string },
  input: {
    readonly message: string;
    readonly calendarContext: AcceptedCalendarContext | null;
    readonly snapshot: RoutingSnapshot;
  },
): ValidatedFoodDayTarget {
  const projection = input.snapshot.projection;
  const facts =
    input.calendarContext === null
      ? null
      : deriveCalendarFacts(input.calendarContext);
  const previous =
    facts === null || facts.localDate === "0001-01-01"
      ? null
      : previousCalendarDate(facts.localDate);
  if (proposal.kind === "DATE_TARGET") {
    const bucket =
      facts === null
        ? null
        : proposal.localDate === facts.localDate
          ? projection.today
          : proposal.localDate === previous
            ? projection.yesterday
            : null;
    // An existing day or incomplete discovery makes a date alone insufficient.
    if (
      projection.days.some((day) => day.localDate === proposal.localDate) ||
      bucket?.hasMore
    )
      return { kind: "CLARIFY", question: ambiguousDayQuestion };
    return proposal;
  }

  const selected = projection.days.find(
    (day) => day.token === proposal.dayToken,
  );
  if (selected === undefined)
    throw new FoodDayTargetResolutionError("UNKNOWN_DAY_TOKEN");
  const bucket =
    facts === null
      ? null
      : selected.localDate === facts.localDate
        ? projection.today
        : selected.localDate === previous
          ? projection.yesterday
          : null;
  const incompleteDateBucket =
    bucket !== null && bucket !== undefined && bucket.hasMore;
  const sameDateCandidates = projection.days.filter(
    (day) =>
      selected.localDate !== null && day.localDate === selected.localDate,
  ).length;
  if (incompleteDateBucket || sameDateCandidates > 1) {
    const conversationalSource = selected.sources.some(
      (source) =>
        source === "ACTIVE_POINTER" || source === "RECENT_COMPLETED_TURN",
    );
    // Explicit date language asks for a date, not pointer-based continuity.
    // A pointer is evidence only when the model selected it without that cue.
    const explicitDate =
      /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/.test(input.message) ||
      /\btoday\b|\byesterday\b|\bthis morning\b|\bthis afternoon\b|\bthis evening\b/i.test(
        input.message,
      );
    if (!conversationalSource || explicitDate)
      return { kind: "CLARIFY", question: ambiguousDayQuestion };
  }
  return { kind: "EXISTING_DAY", foodDayId: proposal.foodDayId };
}

function sameCalendarContext(
  left: AcceptedCalendarContext | null,
  right: AcceptedCalendarContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.schema === right.schema &&
    left.currentLocalDateTime === right.currentLocalDateTime &&
    left.timeZone === right.timeZone
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(value, key) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
        "value" in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}
