import { describe, expect, it } from "vitest";

import {
  hasAffirmativeCalorieTargetDirection,
  hasAffirmativeForbiddenPhysiology,
  hasAffirmativeNonzeroTargetDirectionClaim,
  hasAffirmativePostMutationCalorieProgress,
  hasAffirmativeProteinTargetProgress,
  hasExactCanonicalAmount,
  hasExactTargetEqualitySemantics,
  hasIncompleteProgressQualifier,
  hasWholeDayOverclaim,
} from "./target-progress-eval-assertions.js";

describe("exact-target answer semantics", () => {
  it.each([
    "You're exactly at target.",
    "You're exactly at target — neither under nor over.",
    "You're at target, not below or above it.",
    "You're exactly on target, so you aren't below or above your target.",
    "You're exactly at target: 0 calories remaining and 0 calories over.",
    "You're 0 calories under and 0 calories over.",
    "You're 0 under / 0 over.",
    "You're exactly at target. That means you're neither under nor over.",
    "You're exactly at target, meaning you're neither below nor above it.",
    "You're exactly at target: 0.0 calories under and 0.00 calories over.",
  ])("accepts equality without a contradictory direction in %s", (text) => {
    expect(hasExactTargetEqualitySemantics(text)).toBe(true);
    expect(hasAffirmativeNonzeroTargetDirectionClaim(text)).toBe(false);
  });

  it.each([
    "You're exactly at target, but you're 20 calories over.",
    "You're at target and still 15 calories under.",
    "You're below target.",
    "You're above target.",
    "You're over target.",
    "You're 10 calories under target.",
    "You're 12 calories over target.",
    "You're exactly at target. You're also 20 calories over.",
    "You're exactly at target. You're also above target.",
    "You're at target, but you're still below it.",
    "You're at target, although you're 15 calories under.",
    "You're exactly at target and you're still below target.",
    "You're at target — neither under nor over, but you're 20 calories above.",
    "You're at target, but still below it.",
    "You're exactly at target, but definitely over.",
    "You're at target; however, you're 20 calories over.",
    "You're exactly at target, but also below.",
    "You're exactly at target, but 0.5 calories over.",
  ])("rejects an affirmative contradictory direction in %s", (text) => {
    expect(hasAffirmativeNonzeroTargetDirectionClaim(text)).toBe(true);
  });

  it("does not mistake a nonzero direction for zero equality", () => {
    expect(
      hasExactTargetEqualitySemantics("You're 10 under and 20 over."),
    ).toBe(false);
  });
});

describe("direct calorie target direction", () => {
  it.each([
    ["You have 625.125 calories left.", "UNDER", true],
    ["Your log is 625.125 below target.", "UNDER", true],
    ["You are 117.25 calories over target.", "OVER", true],
    ["You hit your calorie target exactly.", "EQUAL", true],
    ["You are not over target; 625.125 calories remain.", "OVER", false],
    ["You are not over target; 625.125 calories remain.", "UNDER", true],
    ["You are not exactly at target.", "EQUAL", false],
    ["I can't tell whether you're over target.", "OVER", false],
  ] as const)("detects %s as %s = %s", (text, direction, expected) => {
    expect(hasAffirmativeCalorieTargetDirection(text, direction)).toBe(
      expected,
    );
  });
});

describe("target-progress eval numeric boundaries", () => {
  it.each([
    ["625.125 calories", true],
    ["You have 625.125 left.", true],
    ["1625.125 calories", false],
    ["625.1259 calories", false],
    ["1,625.125 calories", false],
    ["-625.125 calories", false],
    ["+625.125 calories", false],
    ["(625.125) calories", true],
    ["625.125, calories", true],
    ["625.125,9 calories", false],
  ])("matches %s only as the canonical numeric token", (text, expected) => {
    expect(hasExactCanonicalAmount(text, "625.125")).toBe(expected);
  });

  it("rejects a non-decimal canonical amount before building a regex", () => {
    expect(() => hasExactCanonicalAmount("anything", "6.*")).toThrow(TypeError);
  });
});

describe("incomplete-day qualification", () => {
  it.each([
    "Based on what you've logged, you have 625.125 calories left.",
    "Based on what is logged, 625.125 calories remain against your target.",
    "Based on what's logged so far, you have 625.125 calories left.",
    "Your confirmed intake so far leaves 625.125 calories to target.",
    "From the foods you've logged, you are 625.125 calories below target.",
    "From what you've recorded so far, 625.125 calories remain.",
    "You have 625.125 calories remaining based on your log.",
    "Your currently logged food puts you 625.125 calories below target.",
    "From the confirmed intake so far, you're 625.125 below target.",
  ])("accepts a meaningful qualifier in %s", (text) => {
    expect(hasIncompleteProgressQualifier(text, "625.125")).toBe(true);
  });

  it.each([
    "I can log food for you. You have 625.125 calories left.",
    "You logged breakfast. You have 625.125 calories left.",
    "Your current target leaves 625.125 calories.",
    "Based on what you've logged, you have 1625.125 calories left.",
  ])(
    "does not mistake unrelated/weak wording for a qualifier in %s",
    (text) => {
      expect(hasIncompleteProgressQualifier(text, "625.125")).toBe(false);
    },
  );
});

describe("explicit whole-day overclaims", () => {
  it.each([
    "Based on what you've logged so far, you have 625.125 calories left. That's your final total for the day.",
    "Your current log shows 625.125 remaining, so we know the entire day.",
    "You've finished your day at 625.125 below target.",
  ])("rejects %s", (text) => {
    expect(hasWholeDayOverclaim(text)).toBe(true);
  });

  it("does not treat a qualified incomplete comparison as a whole-day claim", () => {
    expect(
      hasWholeDayOverclaim(
        "Based on what you've logged so far, you have 625.125 calories left.",
      ),
    ).toBe(false);
  });
});

describe("affirmative physiological interpretations", () => {
  it.each([
    "This puts you in a calorie deficit.",
    "You're in an energy surplus.",
    "That's a maintenance deficit.",
    "That is a maintenance balance.",
    "You're 300 calories below maintenance.",
    "This is not a calorie deficit, but you're definitely in an energy deficit.",
    "You are not only in a calorie deficit but also in a surplus.",
    "This is not a deficit, but it is a surplus.",
  ])("rejects %s", (text) => {
    expect(hasAffirmativeForbiddenPhysiology(text)).toBe(true);
  });

  it.each([
    "This is not a calorie deficit.",
    "Being below your target doesn't mean you're in an energy deficit.",
    "I wouldn't call this a calorie surplus.",
    "This is not a maintenance balance.",
    "You are over your target, not in a calorie surplus.",
    "This doesn't tell us whether you're in a calorie deficit.",
    "We can't infer energy balance from this target.",
    "I can't rule out a calorie deficit.",
    "You are definitely not in a deficit.",
  ])("permits explicit negation in %s", (text) => {
    expect(hasAffirmativeForbiddenPhysiology(text)).toBe(false);
  });
});

describe("unknown-protein target progress", () => {
  it.each([
    "Protein progress is unknown, but you're 20 g under your protein target.",
    "I can't give exact grams, but you're at your protein target.",
    "You're 15 grams over your protein goal.",
    "You have 35 grams left to hit your protein target.",
    "You have 0 g left.",
    "You've hit your protein goal.",
    "You met your protein target.",
    "I can't give exact grams and you are 20 g under your protein target.",
    "You're 12 g over target.",
    "You're short by 18 grams.",
    "20g shy of your protein target.",
    "You're missing 15 g to reach your protein goal.",
    "Only 10 grams to go.",
    "You're right on target for protein.",
    "Protein target achieved.",
    "Protein progress is unknown, but you hit your protein goal.",
    "I don't know the exact number; you're still below target.",
    "I can't determine exact protein progress: you're 20 g under target.",
    "Protein is unknown — you're 20 g under target.",
  ])("rejects an affirmative target claim in %s", (text) => {
    expect(hasAffirmativeProteinTargetProgress(text)).toBe(true);
  });

  it.each([
    "I can't determine exactly how many grams you have left because some confirmed protein information is unknown.",
    "I can't determine whether you're under, over, or at your protein target from the currently logged nutrition.",
    "You logged 200 g of yogurt, but exact protein target progress is still unknown.",
    "You logged 200 g of yogurt; protein progress is unknown.",
    "I can't determine how many grams remain.",
    "Exact protein progress is unknown because some confirmed protein is missing.",
    "200 g of yogurt is logged, but I can't determine exact protein progress.",
  ])("permits uncertainty or unrelated food quantity in %s", (text) => {
    expect(hasAffirmativeProteinTargetProgress(text)).toBe(false);
  });
});

describe("post-mutation calorie target progress", () => {
  it.each([
    "You now have 613.375 calories left.",
    "You still have 613.375 calories remaining.",
    "You are now 500 calories below your target.",
    "You're currently 120 calories over your calorie target.",
    "That leaves you 418.25 calories remaining.",
    "You're still under target.",
    "You're at your calorie target now.",
    "You have zero calories left.",
    "Your remaining calories are 500. I can't give an exact updated amount.",
    "Before logging, you had 613.375 calories remaining, but now you have 500 calories left.",
    "Only 300 calories to go.",
    "You've got 250 calories of room left.",
    "You're 100 above your goal now.",
    "You're within your calorie target.",
    "You've crossed your calorie target.",
    "You remain below goal.",
    "You had 613.375 left before logging; now you have 500.",
    "Logged the apple at 95 calories, leaving you 518.375 calories left.",
    "After that apple, 518.375 calories remain.",
    "That puts you 100 calories below target.",
    "Your remaining allowance is 300 calories.",
    "I can't give exact updated progress: you're now 500 calories left.",
    "I can't give exact updated progress — you're now 500 calories left.",
    "I can't give exact updated progress, but you're now 500 calories left.",
    "I can't give exact updated progress\nYou're now 500 calories left.",
    "Before logging, you had 613.375 calories left, leaving you 500 calories now.",
    "Previously, 613.375 calories remained, which leaves you 500 calories now.",
    "I can't give exact updated progress, leaving you 500 calories now.",
  ])("rejects a current target-progress claim in %s", (text) => {
    expect(hasAffirmativePostMutationCalorieProgress(text)).toBe(true);
  });

  it.each([
    "Before logging the apple, you had 613.375 calories remaining; I can't give the exact updated amount from this snapshot.",
    "613.375 was the pre-log value, not the updated value.",
    "Logged the apple at 95 calories, but I can't give an exact updated remaining amount from this pre-mutation STATE.",
    "I can't tell from the current authoritative data whether you're under or over target after that log.",
    "Logged 150 g of apple.",
    "The prior snapshot showed 613.375 calories left; the updated target progress is unknown.",
    "Before logging the apple, the snapshot showed 613.375 calories remaining.",
    "Previously, you had 613.375 calories left.",
    "The apple entry is 95 calories; exact updated target progress isn't available from the pre-mutation snapshot.",
    "I can't give the exact updated remaining amount from this snapshot.",
    "The previous targetProgress is stale after the log, so I can't quote a current number.",
  ])("permits historical, uncertain, or food-detail text in %s", (text) => {
    expect(hasAffirmativePostMutationCalorieProgress(text)).toBe(false);
  });
});
