/** Eval-only, fixture-specific prose checks; these are not production policy. */

import type {
  FoodDayModelDecision,
  FoodDayModelFinalizationStep,
} from "../agent/turn/food-day-turn-types.js";
import {
  isExactHistoryReadToolDecision,
  isExactWeightToolDecision,
} from "./body-weight-semantics-eval-assertions.js";

const expectedLog = {
  localDate: "2026-10-06",
  sourceValue: "80",
  sourceUnit: "KG",
} as const;

export function isExactLogThenHistoryDecision(
  decision: FoodDayModelDecision,
): boolean {
  return (
    decision.type === "TOOLS" &&
    decision.calls.length === 2 &&
    isExactWeightToolDecision(
      { type: "TOOLS", calls: [decision.calls[0]] },
      expectedLog,
    ) &&
    isExactHistoryReadToolDecision({
      type: "TOOLS",
      calls: [decision.calls[1]],
    })
  );
}

export function isExactLogOnlyDecision(
  decision: FoodDayModelDecision,
): boolean {
  return isExactWeightToolDecision(decision, expectedLog);
}

export function isExactHistoryReadContinuation(
  step: FoodDayModelFinalizationStep,
): boolean {
  return (
    step.type === "READ_TOOL" &&
    isExactHistoryReadToolDecision({ type: "TOOLS", calls: [step.call] })
  );
}

function clauses(text: string): string[] {
  return text
    .replace(/\u2019/g, "'")
    .split(
      /[!?;]\s*|\.(?=\s|$)\s*|\s*[\u2014\u2013]\s*|,\s*(?=(?:but|however|though|yet|so|therefore|your|the|you|no|there|that's|it)\b|\d+(?:\.\d+)?\s*(?:kg|kilograms?|kilos?)\b)|\s+\b(?:but|however|though|yet|so|therefore)\b\s+/i,
    )
    .map((part) => part.trim())
    .filter(Boolean);
}

function decimalMeaning(value: string): string {
  const [whole, fractional = ""] = value.split(".");
  const normalizedWhole = whole!.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fractional.replace(/0+$/, "");
  return normalizedFraction === ""
    ? normalizedWhole
    : `${normalizedWhole}.${normalizedFraction}`;
}

const weightToken =
  /(?<![\d.,])(\d+(?:\.\d+)?)(?![\d.,])\s*(kg|kilograms?|kilos?|lbs?|pounds?)\b/gi;

function exactKg(text: string, value: string): boolean {
  return [...text.matchAll(weightToken)].some(
    (match) =>
      /^(?:kg|kilograms?|kilos?)$/i.test(match[2]!) &&
      decimalMeaning(match[1]!) === decimalMeaning(value),
  );
}

function onlyExpectedWeights(
  text: string,
  allowed: readonly string[],
): boolean {
  return [...text.matchAll(weightToken)].every(
    (match) =>
      /^(?:kg|kilograms?|kilos?)$/i.test(match[2]!) &&
      allowed.some(
        (value) => decimalMeaning(value) === decimalMeaning(match[1]!),
      ),
  );
}

const dateToken =
  /(?<![\d-])2026-10-0([456])(?![\d-])|\bOct(?:ober)?\s+0?([456])(?:,?\s*2026)?\b|\b0?([456])\s+Oct(?:ober)?(?:\s+2026)?\b/gi;

function hasDate(text: string, day: 4 | 5 | 6): boolean {
  return [...text.matchAll(dateToken)].some((match) =>
    [match[1], match[2], match[3]].some((value) => Number(value) === day),
  );
}

function onlyExpectedDates(
  text: string,
  allowedDays: readonly number[],
): boolean {
  for (const match of text.matchAll(
    /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g,
  )) {
    if (
      match[1] !== "2026" ||
      match[2] !== "10" ||
      !allowedDays.includes(Number(match[3]))
    ) {
      return false;
    }
  }
  for (const match of text.matchAll(
    /\bOct(?:ober)?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/gi,
  )) {
    if (
      !allowedDays.includes(Number(match[1])) ||
      (match[2] && match[2] !== "2026")
    ) {
      return false;
    }
  }
  for (const match of text.matchAll(
    /\b(\d{1,2})\s+Oct(?:ober)?(?:\s+(\d{4}))?\b/gi,
  )) {
    if (
      !allowedDays.includes(Number(match[1])) ||
      (match[2] && match[2] !== "2026")
    ) {
      return false;
    }
  }
  return true;
}

function latestWeightClaims(text: string): string[] {
  const claims: string[] = [];
  const forms = [
    /\b(?:latest|current|most recent)\s+(?:logged\s+)?(?:weight|weigh-in|observation|measurement|history|reading)\b.{0,30}\b(?:is|was|at|now|lists|shows|would be|could be|might be)\s*(?:now\s*)?(?:probably\s+|about\s+|roughly\s+)?(\d+(?:\.\d+)?)/gi,
    /\b(?:latest|current|most recent)\s+(?:one|value)?\s*(?:is|was|means|would be|could be|might be)\s*(?:now\s+|probably\s+|about\s+|roughly\s+)*(\d+(?:\.\d+)?)/gi,
    /\b(?:your|the)\s+(?:latest|current|most recent)\s+(?:(?:logged\s+)?(?:weight|weigh-in|observation|measurement)\s+)?(?:is|was|would be|could be|might be)\s*(?:now\s+|probably\s+|about\s+|roughly\s+)*(\d+(?:\.\d+)?)/gi,
    /\b(?:your|the)\s+(?:latest|current|most recent)(?:\s+(?:weight|weigh-in|reading))?\s*[:=]\s*(\d+(?:\.\d+)?)/gi,
    /\b(?:your|the)\s+(?:current\s+)?weight\s+(?:is|was)\s*(?:now\s*)?(\d+(?:\.\d+)?)/gi,
    /(?<![\d.,])(\d+(?:\.\d+)?)(?![\d.,])\s*(?:kg|kilograms?|kilos?|lbs?|pounds?)?\s+(?:is|was|would be|could be|might be)\s+(?:your|the)\s+(?:latest|current|most recent)(?:\s+(?:logged\s+)?(?:weight|weigh-in|one|measurement|observation))?/gi,
    /\b(?:you're|you are)\s+currently\s+(\d+(?:\.\d+)?)\s*(?:kg|kilograms?|kilos?|lbs?|pounds?)/gi,
    /\b(?:use|treat|take|count|pick|choose)\b.{0,35}?(\d+(?:\.\d+)?)\s*(?:kg|kilograms?|kilos?|lbs?|pounds?)?.{0,35}?\bas\s+(?:your|the)\s+(?:latest|current|most recent)(?:\s+(?:weight|weigh-in))?/gi,
  ];
  for (const clause of clauses(text)) {
    for (const form of forms) {
      for (const match of clause.matchAll(form)) {
        if (
          !/\b(?:can't|cannot|couldn't|not|never|won't|unable|don't|wouldn't)\b/i.test(
            clause.slice(0, match.index),
          )
        ) {
          claims.push(match[1]!);
        }
      }
    }
  }
  return claims;
}

function hasUnqualifiedLatestDateClaim(text: string): boolean {
  return clauses(text).some((clause) => {
    const match =
      /\b(?:your|the)\s+(?:latest|most recent)\s+(?:measurement\s+)?date\s+(?:is|was)\s+(?:now\s+)?(?:2026-10-0[456]|Oct(?:ober)?\s+[456])\b/i.exec(
        clause,
      );
    return (
      match !== null &&
      !/\b(?:can't|cannot|not|stale|before|prior|read|history)\b/i.test(
        clause.slice(0, match.index),
      )
    );
  });
}

function hasDerivedClaim(text: string): boolean {
  return clauses(text).some((clause) => {
    const match =
      /\b(?:you(?:'ve| have)?\s+(?:lost|gained)|trending\s+(?:up|down|upward|downward)|(?:went|are|is)\s+(?:up|down)\s+by|(?:you're|you are)\s+(?:up|down)\s+\d|(?:increased|decreased)\s+by|(?:your|the)\s+average\s+(?:is|was)|(?:your|the)\s+BMI\s+(?:is|was)|(?:a|an|that's\s+a)\s+\d+(?:\.\d+)?\s*(?:kg|kilograms?|kilos?)\s+(?:increase|decrease|gain|loss)|\b(?:higher|lower)\s+than)\b/i.exec(
        clause,
      );
    return (
      match !== null &&
      !/\b(?:can't|cannot|not|never|unable|don't|no)\b/i.test(
        clause.slice(0, match.index),
      )
    );
  });
}

function hasInventedMeasurementTime(text: string): boolean {
  return /\b(?:morning|evening|later)\s+(?:weigh-in|measurement)\b|\b(?:measured|weighed)\s+at\s+\d|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(
    text,
  );
}

function plainProse(text: string): string {
  return text.replace(/[*_`]/g, "");
}

function hasLogAcknowledgement(text: string): boolean {
  return clauses(text).some((clause) => {
    const explicitAction = [
      /^(?:(?:I|we)(?:'ve| have)?\s+)?(?:successfully\s+)?(?:logged|recorded|saved|added)\b.{0,55}\b80(?:\.0+)?\s*(?:kg|kilograms?|kilos?)\b/i,
      /^\b80(?:\.0+)?\s*(?:kg|kilograms?|kilos?)\b.{0,45}\b(?:was|has been|is now)\s+(?:logged|recorded|saved|added)\b/i,
      /\b(?:your|the|that)\s+(?:80(?:\.0+)?\s*(?:kg|kilograms?|kilos?)\s+)?(?:weigh-in|measurement|observation|entry)\b.{0,70}\b(?:was|has been|is now)\s+(?:logged|recorded|saved|added)\b/i,
      /^(?:(?:I|we)(?:'ve| have)?\s+)?(?:logged|recorded|saved|added)\s+(?:that|the|your)\s+(?:weigh-in|measurement|observation|entry)\b/i,
      /\b(?:that|the|your)\s+(?:80(?:\.0+)?\s*(?:kg|kilograms?|kilos?)\s+)?(?:weigh-in|measurement|observation|entry)\b.{0,45}\b(?:is now in|was added to)\s+(?:your\s+)?(?:history|log|records)\b/i,
    ];
    return explicitAction.some((pattern) => pattern.test(clause));
  });
}

function contradictsSuccessfulLog(text: string): boolean {
  return /\b(?:couldn't|can't|cannot|didn't|did not|failed to|wasn't able to|unable to)\s+(?:log|record|save|add)\b|\b(?:wasn't|was not|isn't|is not|hasn't been|has not been|were not|never|not)\s+(?:actually\s+)?(?:logged|recorded|saved|added)\b|\bno\s+(?:weigh-in|entry|observation|measurement)\s+was\s+(?:logged|recorded|saved|added)\b|\b(?:corrected|updated|changed|replaced)\s+(?:the\s+)?(?:weigh-in|entry|weight)\b/i.test(
    text.replace(/\u2019/g, "'"),
  );
}

export function isEmptyCanonicalHistoryAnswer(text: string): boolean {
  return (
    /\bno\s+(?:canonical|logged|stored|recorded|weigh-in|weight|history)\b|\b(?:canonical|logged|stored|recorded|weigh-in|history)\b.{0,40}\b(?:empty|none|not returned)\b|\b(?:don't have|do not have|there isn't|there is no|can't confirm|cannot confirm|can't verify|cannot verify)\b.{0,55}\b(?:canonical|logged|stored|recorded|weigh-in|weight|history)\b/i.test(
      text.replace(/\u2019/g, "'"),
    ) &&
    latestWeightClaims(text).length === 0 &&
    !/\b(?:fall\s*back|fallback)\s+to\s+80\.4\s*(?:kg|kilograms?|kilos?)\b/i.test(
      text,
    ) &&
    !hasDerivedClaim(text)
  );
}

export function isOneLatestObservationAnswer(text: string): boolean {
  const latestClaims = latestWeightClaims(text);
  const oneOnLatestDate =
    /\b(?:latest|most recent)\s+(?:measurement\s+)?date\b.{0,80}\b(?:one|1)\s+(?:entry|observation|weigh-in|measurement)\b/i.test(
      text,
    );
  const conciseAnswer =
    [...text.matchAll(weightToken)].length === 1 &&
    [...text.matchAll(dateToken)].length === 1 &&
    !/\b(?:can't|cannot|don't know|not sure|unable)\b/i.test(text);
  return (
    hasDate(text, 6) &&
    onlyExpectedDates(text, [6]) &&
    exactKg(text, "79.8") &&
    onlyExpectedWeights(text, ["79.8"]) &&
    (latestClaims.length > 0 || oneOnLatestDate || conciseAnswer) &&
    latestClaims.every((value) => decimalMeaning(value) === "79.8") &&
    !/(?:\bcreatedAt\b|\bingest(?:ed|ion)\b)/i.test(text) &&
    !hasInventedMeasurementTime(text) &&
    !hasDerivedClaim(text)
  );
}

export function isAmbiguousLatestDateAnswer(text: string): boolean {
  const coequalListing =
    /\b80\.2\s*(?:kg|kilograms?|kilos?)\b.{0,25}\band\b.{0,25}\b81\s*(?:kg|kilograms?|kilos?)\b|\b81\s*(?:kg|kilograms?|kilos?)\b.{0,25}\band\b.{0,25}\b80\.2\s*(?:kg|kilograms?|kilos?)\b/i.test(
      text,
    );
  const ambiguity =
    /\b(?:two|2|both|multiple)\s+(?:canonical\s+)?(?:observations?|weigh-ins?|weights?)\b|\b(?:can't|cannot|not|no|wouldn't)\b.{0,75}\b(?:which|within-day|order|later|unique|latest)\b|\b(?:both\b.{0,40}\band\b|latest\s+measurement\s+date\b.{0,60}\bwith\b)/i.test(
      text,
    );
  const withinDayOrderClaim = clauses(text).some((clause) => {
    const match =
      /\b(?:the\s+)?(?:later|last|second|newest|latest)\s+(?:weigh-in|observation|one)\s+(?:was|is)\s*(?:80\.2|81)\b|\b(?:80\.2|81)\s*kg\s+(?:was|is)\s+(?:the\s+)?(?:later|last|second|newest|latest)\b/i.exec(
        clause,
      );
    return (
      match !== null &&
      !/\b(?:can't|cannot|not|wouldn't|don't|unable)\b/i.test(
        clause.slice(0, match.index),
      )
    );
  });
  return (
    hasDate(text, 6) &&
    onlyExpectedDates(text, [6]) &&
    exactKg(text, "80.2") &&
    exactKg(text, "81") &&
    onlyExpectedWeights(text, ["80.2", "81"]) &&
    (ambiguity || coequalListing) &&
    !withinDayOrderClaim &&
    latestWeightClaims(text).length === 0 &&
    !hasDerivedClaim(text) &&
    !/\b(?:80\.6|80\.60)\s*(?:kg|kilograms?|kilos?)\b/i.test(text)
  );
}

export function isRawRecentHistoryAnswer(text: string): boolean {
  const dates = [...text.matchAll(dateToken)].map((match) => ({
    index: match.index,
    kind: "date" as const,
    value: String(Number(match[1] ?? match[2] ?? match[3])),
  }));
  const weights = [...text.matchAll(weightToken)].map((match) => ({
    index: match.index,
    kind: "weight" as const,
    value: decimalMeaning(match[1]!),
  }));
  const tokens = [...dates, ...weights].sort(
    (left, right) => left.index - right.index,
  );
  const pairs = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const first = tokens[index];
    const second = tokens[index + 1];
    if (!first || !second || first.kind === second.kind) return false;
    const date = first.kind === "date" ? first.value : second.value;
    const weight = first.kind === "weight" ? first.value : second.value;
    if (pairs.has(date)) return false;
    pairs.set(date, weight);
  }
  return (
    dates.length === 3 &&
    weights.length === 3 &&
    pairs.size === 3 &&
    pairs.get("6") === "80" &&
    pairs.get("5") === "79.5" &&
    pairs.get("4") === "79" &&
    onlyExpectedDates(text, [4, 5, 6]) &&
    onlyExpectedWeights(text, ["80", "79.5", "79"]) &&
    !hasDerivedClaim(text) &&
    !hasInventedMeasurementTime(text)
  );
}

export function isBoundedOlderDateAnswer(text: string): boolean {
  const normalized = text.replace(/\u2019/g, "'");
  const limitation =
    /\b(?:bounded|recent|window|older|truncat\w*|history|may omit|might omit)\b/i;
  const uncertainty =
    /\b(?:may|might|could)\b.{0,55}\b(?:omit|outside|older|incomplete|not include|not show|be missing)\b|\b(?:can't|cannot|couldn't|don't|doesn't|does not|unable to)\b.{0,35}\b(?:confirm|tell|determine|establish|conclude|know|see)\b|\b(?:uncertain|not conclusive|not enough)\b/i;
  const definitiveAbsence = clauses(normalized).some((clause) => {
    const claim =
      /\b(?:never logged|didn't log|did not log|you didn't|you did not|no (?:weigh-in|weight|entry|record)|there is no\b.{0,35}\b(?:weigh-in|weight|entry|record)\b|there was no\b.{0,35}\b(?:weigh-in|weight|entry|record)\b)\b/i.exec(
        clause,
      );
    return (
      claim !== null &&
      !/\b(?:can't|cannot|uncertain|whether|not sure|don't know)\b/i.test(
        clause.slice(0, claim.index),
      )
    );
  });
  const unsupportedPresence = clauses(normalized).some((clause) => {
    const claim =
      /\b(?:yes\b.{0,20}\b(?:logged|weigh-in|entry)|you\s+(?:did\s+)?logged|you\s+did\s+log)\b/i.exec(
        clause,
      );
    return (
      claim !== null &&
      !/\b(?:can't|cannot|doesn't|whether|not|uncertain)\b/i.test(
        clause.slice(0, claim.index),
      )
    );
  });
  return (
    limitation.test(normalized) &&
    uncertainty.test(normalized) &&
    !definitiveAbsence &&
    !unsupportedPresence
  );
}

export function isFreshLogAndHistoryAnswer(
  text: string,
  allowOlderObservation = false,
): boolean {
  const prose = plainProse(text);
  const latestClaims = latestWeightClaims(prose);
  const latestDateObservation =
    /\blatest\s+(?:measurement\s+)?date\b.{0,100}\b(?:one|1)\s+(?:canonical\s+)?(?:observation|weigh-in)\b/i.test(
      prose,
    );
  const loggedObservationIsLatest =
    /\b(?:it|that|the\s+(?:weigh-in|observation))\s+is\s+(?:your|the)\s+(?:latest|most recent)\s+(?:logged\s+)?(?:measurement|weigh-in|observation|weight)\b/i.test(
      prose,
    );
  return (
    hasLogAcknowledgement(prose) &&
    !contradictsSuccessfulLog(prose) &&
    hasDate(prose, 6) &&
    onlyExpectedDates(prose, allowOlderObservation ? [5, 6] : [6]) &&
    onlyExpectedWeights(
      prose,
      allowOlderObservation ? ["80", "79.5"] : ["80"],
    ) &&
    /\b(?:latest|most recent|newest)\b/i.test(prose) &&
    (latestClaims.some((value) => decimalMeaning(value) === "80") ||
      latestDateObservation ||
      loggedObservationIsLatest) &&
    !/\b(?:stale|before the log|can't confirm|cannot confirm|don't know|not sure)\b/i.test(
      prose,
    ) &&
    latestClaims.every((value) => decimalMeaning(value) === "80") &&
    !hasDerivedClaim(prose) &&
    !hasInventedMeasurementTime(prose) &&
    !/\b(?:idempotency|retry key|fingerprint|operation key)\b/i.test(prose)
  );
}

/** H may mention the pre-log observation as older, never as latest. */
export function isFreshStaleRepairAnswer(text: string): boolean {
  // H's fresh-read prose may call the canonical latest weight "recorded" rather
  // than "logged"; leave the other scenarios' detectors unchanged.
  const prose = plainProse(text)
    .replace(
      /\b(latest|most recent)\s+recorded\s+(weight|measurement|weigh-in|observation)\b/gi,
      "$1 logged $2",
    )
    .replace(/\bthat's also (your|the) latest\b/gi, "that is $1 latest");
  if (!isFreshLogAndHistoryAnswer(prose, true)) {
    return false;
  }
  const acknowledgedOct6Observation = clauses(prose).some(
    (clause) =>
      hasLogAcknowledgement(clause) &&
      (exactKg(clause, "80") ||
        /\bthat\s+(?:weigh-in|measurement|observation|entry)\b/i.test(
          clause,
        )) &&
      hasDate(clause, 6),
  );
  const latestClaims = latestWeightClaims(prose);
  const loggedObservationIsLatest =
    /\b(?:it|that|the\s+(?:weigh-in|observation))\s+is\s+(?:your|the)\s+(?:latest|most recent)\s+(?:logged\s+)?(?:measurement|weigh-in|observation|weight)\b/i.test(
      prose,
    );
  if (
    !acknowledgedOct6Observation ||
    (latestClaims.length === 0 && !loggedObservationIsLatest) ||
    latestClaims.some((value) => decimalMeaning(value) !== "80") ||
    /\b(?:probably|assum(?:e|ing)|guess(?:ing)?|without checking history|because I just logged it)\b/i.test(
      prose,
    ) ||
    clauses(prose).some((clause) => {
      const latest = /\b(?:latest|most recent)\b/i.exec(clause);
      if (!latest) return false;
      const latestContext = clause
        .slice(latest.index)
        .split(/\b(?:previously|previous|prior|older|before)\b/i)[0]!;
      return hasDate(latestContext, 5) && !hasDate(latestContext, 6);
    }) ||
    /\b(?:latest|most recent)\s+(?:measurement\s+)?date\b.{0,40}\b(?:2026-10-05|Oct(?:ober)?\s+0?5)\b/i.test(
      prose,
    )
  ) {
    return false;
  }
  if (!exactKg(prose, "79.5")) return true;
  return /\b79\.5\s*(?:kg|kilograms?|kilos?)\b.{0,45}\b(?:2026-10-05|Oct(?:ober)?\s+0?5)\b|\b(?:2026-10-05|Oct(?:ober)?\s+0?5)\b.{0,45}\b79\.5\s*(?:kg|kilograms?|kilos?)\b/i.test(
    prose,
  );
}

export function isTrendLimitationAnswer(text: string): boolean {
  const normalized = text.replace(/\u2019/g, "'");
  return (
    /\b(?:can't|cannot|unable|not available|not supported|don't have|no deterministic)\b/i.test(
      normalized,
    ) &&
    /\b(?:calculate|compute|determine|weight.loss|lost|delta|difference)\b/i.test(
      normalized,
    ) &&
    !/\b(?:need|require|missing|lack|without)\b.{0,65}\b(?:two|2|starting|ending|dated|observations?|weights?)\b|\b(?:from|with)\s+the\s+available\s+information\b|\b(?:not enough|don't have enough|insufficient)\s+(?:data|information|observations?|weights?)\b|\b(?:give|provide|supply|send)\b.{0,65}\b(?:two|2|starting|ending)\b/i.test(
      normalized,
    ) &&
    !/[\d]+(?:\.\d+)?\s*(?:kg|kilograms?|kilos?|lbs?|pounds?)\b/i.test(
      normalized,
    ) &&
    !hasDerivedClaim(normalized)
  );
}

export function isStaleReadAnswer(text: string): boolean {
  const stale =
    /\b(?:history|read|result)\b.{0,70}\b(?:before|prior|stale|pre-mutation)\b|\b(?:before|prior|stale|pre-mutation)\b.{0,70}\b(?:history|read|result)\b|\b(?:can't|cannot|unable|not able|don't have)\b.{0,70}\b(?:confirm|establish|verify|latest|post-log)\b.{0,40}\b(?:history|read|result)?\b/i;
  const qualification =
    /\b(?:can't|cannot|unable|not able|don't know|don't have|not enough|no fresh|doesn't(?: yet)?)\b.{0,85}\b(?:confirm|establish|verify|latest|post-log|history)\b/i;
  return (
    hasLogAcknowledgement(text) &&
    !contradictsSuccessfulLog(text) &&
    onlyExpectedWeights(text, ["80", "79.5"]) &&
    stale.test(text.replace(/\u2019/g, "'")) &&
    qualification.test(text.replace(/\u2019/g, "'")) &&
    latestWeightClaims(text).length === 0 &&
    !hasUnqualifiedLatestDateClaim(text) &&
    !hasDerivedClaim(text)
  );
}
