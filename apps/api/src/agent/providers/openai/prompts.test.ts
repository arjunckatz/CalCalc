import { describe, expect, it } from "vitest";

import { decisionInstructions, finalizationInstructions } from "./prompts.js";

describe("FoodDay target-progress instructions", () => {
  it.each([
    ["decision", decisionInstructions],
    ["finalization", finalizationInstructions],
  ])("applies the same canonical progress policy during %s", (_, text) => {
    expect(text).toContain("STATE.targetProgress");
    expect(text).toContain("stateBeforeMutations.targetProgress");
    expect(text).toMatch(
      /Do not recalculate progress from targets, totals, entries, or planned food/,
    );
    expect(text).toMatch(/successful completeness tool result if present/);
    expect(text).toMatch(/UNKNOWN or PARTIAL.*logged or confirmed so far/);
    expect(text).toMatch(/USER_DECLARED_COMPLETE.*whole-day target comparison/);
    expect(text).toMatch(/both "0" means exactly at target/);
    expect(text).toMatch(/protein progress values are null.*unknown/);
    expect(text).toMatch(
      /not a calorie deficit, surplus, or maintenance balance/,
    );
    expect(text).toMatch(/Progress alone never establishes completeness/);
    expect(text).toMatch(
      /Answer progress-only questions directly without tools/,
    );
    expect(text).toMatch(/After a food mutation.*pre-mutation intake/);
    expect(text).toMatch(/do not present it as current/);
  });
});

describe("body-weight observation policy", () => {
  it("requires an actual observation, explicit unit and supported current-message date", () => {
    expect(decisionInstructions).toContain("actual reported weigh-in");
    expect(decisionInstructions).toContain(
      "explicit KG or LB unit and supported date evidence in the current user message",
    );
    expect(decisionInstructions).toContain(
      "An explicit YYYY-MM-DD measurement date works without calendar context",
    );
    expect(decisionInstructions).toContain(
      'resolve standalone "today" to that date and standalone "yesterday" to the preceding Gregorian calendar date',
    );
    expect(decisionInstructions).toContain(
      "Without it, ask for an absolute date when the user says today or yesterday",
    );
    expect(decisionInstructions).toContain(
      "Only today and yesterday are supported relative dates",
    );
    expect(decisionInstructions).toContain(
      "An omitted date does not default to currentLocalDate",
    );
    expect(decisionInstructions).toContain(
      "FoodDay.localDate is not the user's current civil date",
    );
    expect(decisionInstructions).toContain(
      "do not use it, server time, or transcript to resolve a relative or omitted date",
    );
    expect(decisionInstructions).toContain(
      "goals, hypotheticals, aspirations, or vague estimates",
    );
    expect(decisionInstructions).toContain("correction is not supported yet");
    expect(decisionInstructions).toContain(
      "do not answer weight-history or trend questions from transcript",
    );
    expect(decisionInstructions).toContain("Do not calculate kilograms");
  });

  it("uses the authoritative source observation in finalization", () => {
    expect(finalizationInstructions).toContain(
      "source value, source unit, and measurement date",
    );
    expect(finalizationInstructions).toContain(
      "use only the backend tool result",
    );
    expect(finalizationInstructions).toContain("CREATED and REPLAYED");
  });

  it("encodes D and nearby negated-alternative observations without inventing a stored entry", () => {
    expect(decisionInstructions).toContain(
      "Do not infer that a stored weigh-in exists solely because the user negates one date or value and affirms another",
    );
    expect(decisionInstructions).toContain(
      "there is no canonical weight-history read path",
    );
    expect(decisionInstructions).toContain(
      "independently affirms an actual measurement with supported date, value, and unit, use LOG_BODY_WEIGHT for that affirmed observation",
    );
    expect(decisionInstructions).toContain(
      '"I wasn\'t 80 kg on 2026-10-05; I was 80 kg on 2026-10-06" means call LOG_BODY_WEIGHT with localDate 2026-10-06, sourceValue 80, sourceUnit KG; it is not a correction',
    );
  });

  it("encodes F and nearby existing-weigh-in edit paraphrases without appending", () => {
    expect(decisionInstructions).toContain(
      '"Correction: the 2026-10-05 weigh-in was 79.8 kg, not 80.8 kg" targets an existing weigh-in and must be answered without a tool',
    );
    expect(decisionInstructions).toContain(
      "Positive evidence of correction intent includes requests to change, update, correct, replace, or remove",
    );
    for (const referent of [
      '"the weigh-in"',
      '"that weigh-in"',
      '"the entry"',
      '"the one I logged"',
      "an earlier weigh-in",
    ]) {
      expect(decisionInstructions).toContain(referent);
    }
    expect(decisionInstructions).toContain(
      "such an existing observation should have had a different value",
    );
    expect(decisionInstructions).toContain("correction is not supported yet");
    expect(decisionInstructions).toContain("never append a replacement row");
    expect(decisionInstructions).toContain(
      "Relative-date resolution does not make an existing-weigh-in correction loggable",
    );
  });
});
