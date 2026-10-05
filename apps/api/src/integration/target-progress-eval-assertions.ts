/**
 * Eval-only, deliberately narrow English heuristics. They cover the tested
 * claim families, not arbitrary paraphrases or a general language grammar.
 * Never use these detectors to make production nutrition decisions.
 */

function normalizeApostrophes(text: string): string {
  return text.replace(/\u2019/g, "'");
}

function sentences(text: string): string[] {
  return normalizeApostrophes(text)
    .split(/[!?;.]\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function clauses(text: string): string[] {
  return sentences(text).flatMap((sentence) =>
    sentence
      .split(
        /\s*,?\s+\b(?:but|however|yet|though|although)\b\s+|,\s*(?=you(?:'re| are| have)\b|I(?: can| can't| cannot)\b|now\b|currently\b|after\b|leaving\s+you\b|which\s+leaves\s+you\b)|:\s*(?=you(?:'re| are| have)\b|now\b|currently\b)|\s+[—–]\s+|\s+\band now\b\s+|\s+\band\b\s+(?=you(?:'re| are| have)\b)/i,
      )
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

/** Match the canonical decimal itself, not a substring of another number. */
export function hasExactCanonicalAmount(text: string, amount: string): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) {
    throw new TypeError("A canonical nonnegative decimal is required.");
  }
  const escaped = amount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.,+-])${escaped}(?![\\d.]|,\\d)`).test(text);
}

const meaningfulQualifier =
  /\b(?:logged|recorded|confirmed|tracked)\s+(?:so far|thus far|to date)\b|\b(?:currently|so far)\s+(?:logged|recorded|confirmed|tracked)\b|\bbased on\s+(?:(?:what(?:'s|\s+(?:you(?:'ve| have)|is|has been))|your)\s+)?(?:logged|recorded|confirmed|tracked|log)\b|\bfrom\s+(?:the foods|what)\s+(?:you(?:'ve| have)|is|has been)\s+(?:logged|recorded|confirmed|tracked)\b|\b(?:your|the)\s+(?:food\s+)?log\s+(?:so far|to date)\b|\b(?:your|the)\s+(?:logged|recorded|confirmed)\s+(?:intake|foods?|entries)\s+(?:so far|to date)\b/i;

/** The qualification must accompany the canonical progress in one sentence. */
export function hasIncompleteProgressQualifier(
  text: string,
  canonicalAmount: string,
): boolean {
  return sentences(text).some(
    (sentence) =>
      hasExactCanonicalAmount(sentence, canonicalAmount) &&
      meaningfulQualifier.test(sentence),
  );
}

const wholeDayOverclaim =
  /\b(?:you(?:'ve| have)?\s+(?:finished|completed)\s+(?:your|the)\s+day|your\s+(?:full|entire|whole)\s+day\s+(?:is|was)\s+(?:known|recorded)|definitely\s+(?:have|had)|\d+(?:\.\d+)?\s+calories?\s+left\s+to\s+eat\s+today|(?:that's|that is|this is)\s+(?:your|the)\s+final\s+total\s+for\s+the\s+day|(?:we|you)\s+know\s+(?:the|your)\s+(?:entire|whole|full)\s+day)\b/i;

export function hasWholeDayOverclaim(text: string): boolean {
  return wholeDayOverclaim.test(normalizeApostrophes(text));
}

const physiologyClaim =
  /\b(?:(?:(?:calorie|energy|maintenance)\s+)?(?:deficit|surplus)|maintenance\s+(?:gap|balance)|\d+(?:\.\d+)?\s*(?:calories|kcal)?\s+(?:below|under|above|over)\s+(?:your\s+)?maintenance)\b/gi;
const explicitNegationBeforeClaim =
  /\b(?:not(?!\s+only)|no|isn't|wasn't|wouldn't|can't|cannot|doesn't|don't)\b[^,;.!?]{0,70}$/i;

export function hasAffirmativeForbiddenPhysiology(text: string): boolean {
  return clauses(text).some((clause) => {
    for (const match of clause.matchAll(physiologyClaim)) {
      const preceding = clause.slice(
        Math.max(0, match.index - 80),
        match.index,
      );
      if (!explicitNegationBeforeClaim.test(preceding)) return true;
    }
    return false;
  });
}

const uncertainty =
  /\b(?:can't|cannot|couldn't|unable|don't know|do not know|unknown|uncertain|not enough|insufficient|not possible|can't tell|cannot tell|can't determine|cannot determine|can't say|cannot say|can't give|cannot give|may|might)\b/i;
const historical =
  /\b(?:before\s+(?:logging|the log|the mutation)|pre[- ](?:log|mutation|turn)|previous(?:ly)?|old value|prior snapshot|before\s+(?:I|you)\s+(?:logged|added))\b/i;

const numericGramProgress =
  /\b\d+(?:\.\d+)?\s*(?:g|grams?)\b.{0,30}\b(?:left|remaining|under|below|over|above|short|shy|to go)\b|\b(?:left|remaining|under|below|over|above|short|missing)\b.{0,30}\b\d+(?:\.\d+)?\s*(?:g|grams?)\b/i;
const bareGramProgress =
  /\b\d+(?:\.\d+)?\s*(?:g|grams?)\s+(?:left|remaining|under|below|over|above|to go)\b|\bshort\s+by\s+\d+(?:\.\d+)?\s*(?:g|grams?)\b/i;
const proteinEquality =
  /\b(?:at|on)\s+(?:(?:your|the)\s+)?(?:protein\s+)?(?:target|goal)\b|\b(?:hit|met|reached)\s+(?:(?:your|the)\s+)?(?:protein\s+)?(?:target|goal)\b|\b(?:protein\s+)?(?:target|goal)\s+(?:achieved|met|reached)\b/i;
const qualitativeProteinProgress =
  /\b(?:under|below|over|above|short of|shy of)\s+(?:(?:your|the)\s+)?(?:protein\s+)?(?:target|goal)\b/i;

/** Reject affirmative target progress, not unrelated food gram quantities. */
export function hasAffirmativeProteinTargetProgress(text: string): boolean {
  return clauses(text).some((clause) => {
    if (uncertainty.test(clause)) return false;
    if (/\bcalorie\b/i.test(clause) && !/\bprotein\b/i.test(clause)) {
      return false;
    }
    return (
      bareGramProgress.test(clause) ||
      (numericGramProgress.test(clause) &&
        /\b(?:protein|target|goal)\b/i.test(clause)) ||
      proteinEquality.test(clause) ||
      qualitativeProteinProgress.test(clause)
    );
  });
}

const numericCalorieProgress =
  /\b\d+(?:\.\d+)?\s*(?:calories|kcal)?\s*(?:left|remaining|remain|remains|under|below|over|above|to go)\b|\b(?:left|remaining|under|below|over|above)\s*(?:by|of|:|is)?\s*\d+(?:\.\d+)?\s*(?:calories|kcal)?\b|\b(?:remaining|left)\s+(?:calories|kcal)\s*(?:are|is|:)?\s*\d+(?:\.\d+)?\b|\b(?:leaves?|leaving)\s+you\s+\d+(?:\.\d+)?\s*(?:calories|kcal)\b|\b\d+(?:\.\d+)?\s*(?:calories|kcal)\s+(?:of\s+)?room\s+left\b|\bremaining\s+allowance\s+(?:is|:)\s+\d+(?:\.\d+)?\s*(?:calories|kcal)?\b|\bnow\s+you\s+have\s+\d+(?:\.\d+)?\b|\b(?:no|zero)\s+(?:calories|kcal)\s+(?:left|remaining)\b/i;
const qualitativeTargetProgress =
  /\b(?:under|below|over|above|at|on|within)\s+(?:(?:your|the)\s+)?(?:calorie\s+)?(?:target|goal)\b|\b(?:hit|met|reached|crossed|passed|exceeded)\s+(?:(?:your|the)\s+)?(?:calorie\s+)?(?:target|goal)\b/i;

/** Post-mutation progress is unavailable until a fresh canonical STATE exists. */
export function hasAffirmativePostMutationCalorieProgress(
  text: string,
): boolean {
  return clauses(text).some(
    (clause) =>
      !historical.test(clause) &&
      !uncertainty.test(clause) &&
      (numericCalorieProgress.test(clause) ||
        qualitativeTargetProgress.test(clause)),
  );
}

const targetDirectionPatterns = {
  UNDER:
    /\b\d+(?:\.\d+)?\s*(?:calories|kcal)?\s*(?:left|remaining|remain|remains|under|below)\b|\b(?:under|below)\b.{0,25}\btarget\b|\btarget\b.{0,25}\b(?:under|below)\b/i,
  OVER: /\b\d+(?:\.\d+)?\s*(?:calories|kcal)?\s*(?:over|above)\b|\b(?:over|above)\b.{0,25}\btarget\b|\btarget\b.{0,25}\b(?:over|above)\b/i,
  EQUAL:
    /\b(?:exactly|right)\s+(?:at|on)\b.{0,22}\btarget\b|\b(?:at|on|hit|met|reached)\s+(?:your|the)?\s*(?:calorie\s+)?target\b|\btarget\b.{0,22}\b(?:exactly|met|achieved)\b/i,
} as const;

/** Eval-only direction check; a negated direction is not an affirmative claim. */
export function hasAffirmativeCalorieTargetDirection(
  text: string,
  direction: keyof typeof targetDirectionPatterns,
): boolean {
  return clauses(text).some((clause) => {
    if (uncertainty.test(clause)) return false;
    const match = targetDirectionPatterns[direction].exec(clause);
    if (!match) return false;
    return !explicitNegationBeforeClaim.test(clause.slice(0, match.index));
  });
}

const zeroUnderOrRemaining =
  /(?<![\d.,])0+(?:\.0+)?\s*(?:calories|kcal)?\s*(?:under|below|remaining|left)\b/i;
const zeroOver =
  /(?<![\d.,])0+(?:\.0+)?\s*(?:calories|kcal)?\s*(?:over|above)\b/i;

/** Equality can be stated directly or as zero progress in both directions. */
export function hasExactTargetEqualitySemantics(text: string): boolean {
  return (
    hasAffirmativeCalorieTargetDirection(text, "EQUAL") ||
    (zeroUnderOrRemaining.test(text) && zeroOver.test(text))
  );
}

const numericDirection =
  /\b(\d+(?:\.\d+)?)\s*(?:calories|kcal)?\s*(?:under|below|over|above)\b/gi;
const negatedDirection =
  /\b(?:neither\s+(?:under|below|over|above)\s+(?:nor|or)\s+(?:under|below|over|above)|(?:not|aren't|are not|isn't|is not|can't be|cannot be)\s+(?:described\s+as\s+)?(?:under|below|over|above)(?:\s+(?:or|nor|and)\s+(?:under|below|over|above))?)\b/gi;
const qualitativeDirection =
  /\b(?:you(?:'re| are)|you remain|(?:the\s+)?(?:day|intake)\s+is)\s+(?:(?:still|also|actually|definitely|now)\s+)?(?:under|below|over|above)\b|\b(?:still|also|actually|definitely)\s+(?:under|below|over|above)\b|\b(?:under|below|over|above)\s+(?:(?:your|the)\s+)?(?:calorie\s+)?(?:target|goal)\b/i;

/** Scenario D only: reject affirmative nonzero direction, not zero or negation. */
export function hasAffirmativeNonzeroTargetDirectionClaim(
  text: string,
): boolean {
  return clauses(text).some((clause) => {
    const withoutNegations = clause.replace(negatedDirection, "");
    for (const match of withoutNegations.matchAll(numericDirection)) {
      if (!/^0+(?:\.0+)?$/.test(match[1] ?? "")) return true;
    }
    const withoutNumbers = withoutNegations.replace(numericDirection, "");
    return qualitativeDirection.test(withoutNumbers);
  });
}
