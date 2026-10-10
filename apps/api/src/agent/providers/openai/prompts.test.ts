import { describe, expect, it } from "vitest";

import {
  decisionInstructions,
  finalizationInstructions,
  finalizeOrReadInstructions,
  terminalFinalizationInstructions,
} from "./prompts.js";

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
  it.each([
    ["first post-tool", finalizeOrReadInstructions],
    ["terminal", terminalFinalizationInstructions],
  ])("preserves successful mutation acknowledgment during %s", (_, text) => {
    expect(text).toContain(
      "When a requested mutation succeeded, explicitly acknowledge that completed action",
    );
    expect(text).toContain(
      "a later canonical read may answer another part of the request but must not erase the mutation acknowledgment",
    );
    expect(text).toContain(
      "Answer that read part from its authoritative result",
    );
    expect(text).toContain(
      "Do not claim success for an absent or failed mutation result",
    );
    expect(text).toContain("without a verbose receipt");
    expect(text).toContain(
      "clearly say the reported weigh-in was logged, recorded, saved, or added",
    );
    expect(text).toContain(
      "merely describing the latest history observation does not acknowledge this turn's log",
    );
    expect(text).toContain("without implying a new row on replay");
  });

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
  it("allows one model-selected fresh read after mutation without making every log a history query", () => {
    expect(finalizeOrReadInstructions).toContain(
      "If the user's still-unanswered supported request needs canonical body-weight history",
    );
    expect(finalizeOrReadInstructions).toContain(
      "A history read is stale for post-mutation history when a successful LOG_BODY_WEIGHT follows it",
    );
    expect(finalizeOrReadInstructions).toContain(
      "A read after the last successful LOG_BODY_WEIGHT is fresh for body-weight history, even if an unrelated food mutation follows",
    );
    expect(finalizeOrReadInstructions).toContain(
      "For a simple weigh-in without a history question, answer without reading history",
    );
    expect(terminalFinalizationInstructions).toContain(
      "No tools are available in this final step",
    );
    expect(terminalFinalizationInstructions).toContain(
      "do not invent a missing canonical read",
    );
  });

  it("asks for all supported intents in ordered batches without mentally patching history", () => {
    expect(decisionInstructions).toContain(
      "Fulfill all supported action and read intents in the current user turn",
    );
    expect(decisionInstructions).toContain(
      "emit all required calls in one decision in executable order",
    );
    expect(decisionInstructions).toContain(
      "a canonical read that must observe a mutation goes after that mutation",
    );
    expect(decisionInstructions).toContain(
      "LOG_BODY_WEIGHT then GET_BODY_WEIGHT_HISTORY",
    );
    expect(decisionInstructions).toContain(
      "Do not infer canonical history from a mutation result",
    );
    expect(decisionInstructions).toContain(
      "even two dated observations do not authorize model-side arithmetic",
    );
  });

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
      "preferably emit both calls in one decision: LOG_BODY_WEIGHT before GET_BODY_WEIGHT_HISTORY",
    );
    expect(decisionInstructions).toContain(
      "Do not infer post-log history from the mutation result",
    );
    expect(decisionInstructions).toContain(
      "a bounded post-tool step can request the missing read",
    );
    expect(decisionInstructions).toContain(
      "A read before a later LOG_BODY_WEIGHT is stale",
    );
    expect(finalizationInstructions).toContain(
      "If that read precedes a later LOG_BODY_WEIGHT in the same turn, it is stale",
    );
    expect(finalizationInstructions).toContain(
      "must not be presented as post-mutation history or patched with guessed values",
    );
  });

  it("limits pure weight calculations by capability, not by the amount of raw data", () => {
    expect(decisionInstructions).toContain(
      "For a pure body-weight trend, delta, average, rate, BMI, or weight-loss calculation request, return FINAL without tools",
    );
    expect(decisionInstructions).toContain(
      "no deterministic calculation primitive exists",
    );
    expect(decisionInstructions).toContain(
      "even two dated observations do not authorize model-side arithmetic",
    );
    expect(decisionInstructions).toContain(
      "If raw history is also requested, read it and limit only the calculation",
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
