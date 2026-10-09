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
      "Do not answer weight-history or trend questions from transcript",
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
      "check canonical history with GET_BODY_WEIGHT_HISTORY when the user asks about stored observations",
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

describe("canonical body-weight history policy", () => {
  it("selects the zero-argument read for canonical history without weakening correction safety", () => {
    expect(decisionInstructions).toContain(
      "Use the zero-argument GET_BODY_WEIGHT_HISTORY for questions about latest logged weight or measurement date, recent weigh-ins, canonical history, or a particular absolute date",
    );
    expect(decisionInstructions).toContain(
      "do not turn a correction into a new log",
    );
    expect(decisionInstructions).toContain(
      "Such a correction is not supported yet; never append a replacement row",
    );
    expect(decisionInstructions).not.toContain(
      "No canonical weight history or latest-weight data is available",
    );
  });

  it.each([
    ["decision", decisionInstructions],
    ["finalization", finalizationInstructions],
  ])(
    "treats the read as authoritative and communicates bounded ambiguity in %s",
    (_, text) => {
      expect(text).toContain(
        "A successful GET_BODY_WEIGHT_HISTORY result is the authority for canonical body-weight history, not transcript",
      );
      expect(text).toContain("latestMeasurementDate is null");
      expect(text).toContain("latestDateObservationCount is 0");
      expect(text).toContain("If the latest date has one observation");
      expect(text).toContain("if it has more than one");
      expect(text).toContain('not a single "latest weight"');
      expect(text).toContain("latestDateObservationsComplete=true");
      expect(text).toContain("recentHistoryMayBeTruncated=true");
      expect(text).toContain("recentHistoryMayBeTruncated=false");
      expect(text).toContain(
        "an absent date under that flag does not prove no observation was logged",
      );
      expect(text).toContain(
        "array order within one date is presentation only",
      );
      expect(text).toContain(
        "sourceValue/sourceUnit or backend weightKg strings exactly",
      );
      expect(text).toContain(
        "Do not calculate trend, delta, average, rate, BMI, or weight loss",
      );
    },
  );

  it("orders a compound log before its read and refuses stale post-mutation claims", () => {
    expect(decisionInstructions).toContain(
      "call LOG_BODY_WEIGHT before GET_BODY_WEIGHT_HISTORY",
    );
    expect(decisionInstructions).toContain(
      "a read before a later LOG_BODY_WEIGHT is stale",
    );
    expect(finalizationInstructions).toContain(
      "If that read precedes a later LOG_BODY_WEIGHT in the same turn, it is stale",
    );
    expect(finalizationInstructions).toContain(
      "must not be presented as post-mutation history or patched with guessed values",
    );
  });

  it("does not fabricate relative history dates when finalization lacks calendar context", () => {
    expect(decisionInstructions).toContain(
      "For a purely today/yesterday history lookup, ask for an absolute YYYY-MM-DD date",
    );
    expect(decisionInstructions).toContain(
      "This does not change today/yesterday eligibility for LOG_BODY_WEIGHT",
    );
    expect(finalizationInstructions).toContain(
      "Finalization receives no trusted CURRENT CALENDAR CONTEXT",
    );
    expect(finalizationInstructions).toContain(
      "an independent latest-history question can still use latestMeasurementDate from the read",
    );
  });
});
