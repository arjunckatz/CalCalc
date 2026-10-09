/** Eval-only, bounded English checks for body-weight fixtures; never production policy. */

import type { FoodDayModelDecision } from "../agent/turn/food-day-turn-types.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";

export interface ExpectedWeightArguments {
  readonly localDate: string;
  readonly sourceValue: string;
  readonly sourceUnit: "KG" | "LB";
}

export function isExactWeightToolDecision(
  decision: FoodDayModelDecision,
  expected: ExpectedWeightArguments,
): boolean {
  if (decision.type !== "TOOLS" || decision.calls.length !== 1) return false;
  try {
    const parsed = parseFoodDayToolCall(decision.calls[0]);
    return (
      parsed.name === "LOG_BODY_WEIGHT" &&
      Object.keys(parsed.arguments).length === 3 &&
      parsed.arguments.localDate === expected.localDate &&
      parsed.arguments.sourceValue === expected.sourceValue &&
      parsed.arguments.sourceUnit === expected.sourceUnit
    );
  } catch {
    return false;
  }
}

/** The historical transcript-only fixture now requires a canonical read. */
export function isExactHistoryReadToolDecision(
  decision: FoodDayModelDecision,
): boolean {
  if (decision.type !== "TOOLS" || decision.calls.length !== 1) return false;
  try {
    const parsed = parseFoodDayToolCall(decision.calls[0]);
    return (
      parsed.name === "GET_BODY_WEIGHT_HISTORY" &&
      Object.keys(parsed.arguments).length === 0
    );
  } catch {
    return false;
  }
}

function normalizeApostrophes(text: string): string {
  return text.replace(/\u2019/g, "'");
}

function clauses(text: string): string[] {
  return normalizeApostrophes(text)
    .split(
      /[!?;]\s*|\.(?=\s|$)\s*|:\s*(?=(?:I|we|you|it|that|this|for now|logged|recorded|updated|corrected|changed|removed|added)\b)|,\s*(?=for now\b|(?:I|we)(?:'ll|\s+(?:will|have|logged|recorded|saved|added|updated|corrected|changed|removed|fixed|edited|used))\b)|\s+\b(?:but|however|though|yet|so|instead)\b\s+|\s*[—–]\s*/i,
    )
    .map((part) => part.trim())
    .filter(Boolean);
}

const mutationVerb =
  /\b(?:logged|recorded|saved|added|noted|updated|corrected|changed|removed|replaced|deleted|fixed|edited|used|use|assume|applied)\b/gi;
const futureMutation =
  /\b(?:I|we)(?:'ll|\s+will)\s+(?:log|record|save|add|update|correct|change|remove|replace|delete|fix|edit|apply)\b/gi;
const completedWeightLog = /\b(?:logged|recorded|saved|added|noted)\b/gi;
const negation =
  /\b(?:not|never|no|nothing|can't|cannot|couldn't|won't|didn't|haven't|isn't|wasn't|aren't|weren't|unable)\b/i;

/** A later positive clause is not excused by an earlier negative clause. */
export function hasAffirmativeMutationClaim(text: string): boolean {
  return clauses(text).some((clause) => {
    for (const match of [
      ...clause.matchAll(mutationVerb),
      ...clause.matchAll(futureMutation),
    ]) {
      if (!negation.test(clause.slice(0, match.index))) return true;
    }
    return false;
  });
}

function hasAffirmativeCompletedWeightLog(text: string): boolean {
  return [...text.matchAll(completedWeightLog)].some(
    (match) => !negation.test(text.slice(0, match.index)),
  );
}

const weightAmount =
  /(?<![\d.,])(\d+(?:\.\d+)?)\s*(kg|kilograms?|kilos?|lbs?|pounds?)\b/gi;

export function isSuccessfulWeightAcknowledgement(text: string): boolean {
  if (
    !/(?<![\p{L}\p{N}_-])2026-10-05(?![\p{L}\p{N}_-])|\bOct(?:ober)?\s+0?5\b/iu.test(
      text,
    ) ||
    [...text.matchAll(/\b\d{4,}-\d{2}-\d{2,}\b/g)].some(
      (match) => match[0] !== "2026-10-05",
    ) ||
    [...text.matchAll(/\bOct(?:ober)?\s+(\d{1,2})\b/gi)].some(
      (match) => match[1] !== "5",
    )
  ) {
    return false;
  }
  if (
    /\b(?:latest|current weight|weight trend|lost|gained|idempotency|retry|operation key|fingerprint)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  const amounts = [...text.matchAll(weightAmount)];
  if (
    amounts.length === 0 ||
    amounts.some(
      (match) =>
        match[1] !== "80.4" ||
        !/^(?:kg|kilograms?|kilos?)$/i.test(match[2] ?? ""),
    )
  ) {
    return false;
  }
  return clauses(text).some(
    (clause) =>
      hasAffirmativeCompletedWeightLog(clause) &&
      [...clause.matchAll(weightAmount)].some(
        (match) =>
          match[1] === "80.4" &&
          /^(?:kg|kilograms?|kilos?)$/i.test(match[2] ?? ""),
      ),
  );
}

function hasAffirmativeAppointmentDateAssignment(text: string): boolean {
  return clauses(text).some((clause) => {
    if (!clause.includes("2026-10-05")) return false;
    const match =
      /\b(?:weigh(?:-in|t|ed)?|measurement|weight)\b.{0,45}\b(?:on|for)\s+2026-10-05\b/i.exec(
        clause,
      ) ??
      /\b2026-10-05\b.{0,45}\b(?:is|was)\b.{0,30}\b(?:weigh-in|measurement|weight)\b/i.exec(
        clause,
      );
    return match !== null && !negation.test(clause.slice(0, match.index));
  });
}

export function isDateClarification(text: string): boolean {
  const uncertain =
    /\b(?:which|what|confirm|specify|provide|give me|tell me|clarif\w*|can't|cannot|won't|not assume|need)\b.{0,90}\b(?:date|day|today)\b|\b(?:date|day|today)\b.{0,90}\b(?:which|what|confirm|specify|provide|give me|clarif\w*|can't|cannot|won't|not assume|need)\b/i.test(
      text,
    );
  return (
    uncertain &&
    !hasAffirmativeMutationClaim(text) &&
    !hasAffirmativeAppointmentDateAssignment(text)
  );
}

/** A clarification cannot also assign a calendar date in a later clause. */
export function isSafeDateClarification(text: string): boolean {
  // These question/conditional forms are requests for a date, not claims that
  // a date was chosen or a weigh-in was already logged.
  const evaluated = normalizeApostrophes(text)
    .replace(
      /\b((?:what|which)\s+(?:(?:calendar|measurement)\s+)?date\s+should\s+I)\s+use\b/gi,
      "$1 choose",
    )
    .replace(
      /\b(?:you'd|you would)\s+like(?:\s+(?:it|that))?\s+logged\b/gi,
      "you want to log",
    );
  const clarification =
    isDateClarification(evaluated) ||
    /\bwhen\s+did\s+(?:you|I|we|they)\s+weigh\b/i.test(evaluated) ||
    /\b(?:can't|cannot|won't|will not|unable to)\b.{0,50}\b(?:resolve|infer|assume|determine)\b.{0,70}\b(?:yesterday|today)\b/i.test(
      evaluated,
    );
  const dateAssignment =
    /\b(?:it(?:'s|\s+(?:is|was))|yesterday\s+(?:is|was|means)|(?:the\s+)?date\s+(?:is|was)|(?:treat|treated|take|took|interpret|interpreted|count|counted)\b.{0,40}\bas)\s+(?:\d{4}-\d{2}-\d{2}|today|yesterday|oct(?:ober)?\s+\d{1,2})\b/i;
  return (
    clarification &&
    !hasAffirmativeMutationClaim(evaluated) &&
    !hasAffirmativeAppointmentDateAssignment(evaluated) &&
    !clauses(evaluated).some((clause) => {
      const match = dateAssignment.exec(clause);
      return match !== null && !negation.test(clause.slice(0, match.index));
    })
  );
}

export function isGoalNotObservationResponse(text: string): boolean {
  const normalized = normalizeApostrophes(text);
  return (
    ((/\b(?:goals?|targets?)\b/i.test(normalized) &&
      /\b(?:weigh-ins?|observed|observations?|measurements?|measured|actual|LOG_BODY_WEIGHT|log)\b/i.test(
        normalized,
      )) ||
      /\b(?:I|we)\s+(?:can|could)\s+(?:log|record)\b.{0,80}\b(?:actual|measured|observed)\b.{0,80}\b(?:instead|when|if)\b/i.test(
        normalized,
      )) &&
    !hasAffirmativeMutationClaim(normalized)
  );
}

export function isCorrectionUnavailableResponse(text: string): boolean {
  const normalized = normalizeApostrophes(text);
  return (
    /\b(?:correct\w*|edit\w*|updat\w*|chang\w*|existing|previous|prior|weigh-ins?|observations?|replacement)\b/i.test(
      normalized,
    ) &&
    (/\b(?:can't|cannot|don't have|not available|not supported|aren't supported|isn't supported|unable|no way to)\b/i.test(
      normalized,
    ) ||
      /\b(?:no new|nothing|did not|didn't|was not|wasn't)\b.{0,80}\b(?:logged|recorded|updated|replacement|observation)\b/i.test(
        normalized,
      )) &&
    !hasAffirmativeMutationClaim(normalized)
  );
}

/** Offline guard against claiming a transcript-only value as latest weight. */
function hasAffirmativeLatestWeightClaim(text: string): boolean {
  return clauses(text).some((clause) => {
    const match =
      /\b(?:latest|current|most recent)\b.{0,35}\b(?:weight|weigh-in)\b.{0,25}\b(?:is|was|at)\b.{0,15}\b\d+(?:\.\d+)?\b/i.exec(
        clause,
      ) ??
      /\b(?:that|it|this)(?:'s|\s+(?:is|was))\s+(?:your\s+)?(?:current|latest|most recent)\s+(?:weight|weigh-in)\b/i.exec(
        clause,
      ) ??
      /\b\d+(?:\.\d+)?\s*(?:kg|kilograms?|kilos?|lbs?|pounds?)\s+(?:is|was)\s+(?:your\s+)?(?:current|latest|most recent)\s+(?:weight|weigh-in)\b/i.exec(
        clause,
      );
    return match !== null && !negation.test(clause.slice(0, match.index));
  });
}

/** Retained for offline regression checks; live history requests now use the read. */
export function isCanonicalHistoryUncertainResponse(text: string): boolean {
  const normalized = normalizeApostrophes(text);
  if (
    !/\b(?:can't|cannot|don't have|no access|not available|can't determine|cannot tell|unable)\b/i.test(
      normalized,
    ) ||
    !/\b(?:history|latest|most recent|current)\b/i.test(normalized) ||
    hasAffirmativeMutationClaim(normalized) ||
    hasAffirmativeLatestWeightClaim(normalized)
  ) {
    return false;
  }
  return clauses(normalized).every(
    (clause) =>
      !/\b80\.4\s*(?:kg|kilograms?|kilos?)\b/i.test(clause) ||
      /\b(?:mentioned|said|conversation|transcript|earlier)\b/i.test(clause),
  );
}

export function boundedAnswerExcerpt(text: string): string {
  return text.slice(0, 240);
}
