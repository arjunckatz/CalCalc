import { describe, expect, it } from "vitest";

import {
  boundedAnswerExcerpt,
  hasAffirmativeMutationClaim,
  isCanonicalHistoryUncertainResponse,
  isCorrectionUnavailableResponse,
  isDateClarification,
  isExactWeightToolDecision,
  isGoalNotObservationResponse,
  isSafeDateClarification,
  isSuccessfulWeightAcknowledgement,
} from "./body-weight-semantics-eval-assertions.js";

describe("body-weight semantic eval assertion helpers", () => {
  it("requires one exact production-parsed weight call", () => {
    const expected = {
      localDate: "2026-10-05",
      sourceValue: "80.4",
      sourceUnit: "KG" as const,
    };
    const call = { name: "LOG_BODY_WEIGHT", arguments: expected };
    expect(
      isExactWeightToolDecision({ type: "TOOLS", calls: [call] }, expected),
    ).toBe(true);
    expect(
      isExactWeightToolDecision({ type: "FINAL", text: "Done." }, expected),
    ).toBe(false);
    expect(
      isExactWeightToolDecision(
        { type: "TOOLS", calls: [call, call] },
        expected,
      ),
    ).toBe(false);
    expect(
      isExactWeightToolDecision(
        { type: "TOOLS", calls: [{ name: "LOG_FOOD", arguments: expected }] },
        expected,
      ),
    ).toBe(false);
    expect(
      isExactWeightToolDecision(
        {
          type: "TOOLS",
          calls: [{ ...call, userId: "attacker" }],
        },
        expected,
      ),
    ).toBe(false);
    for (const argumentsValue of [
      { ...expected, localDate: "2026-10-06" },
      { ...expected, sourceValue: "80.5" },
      { ...expected, sourceUnit: "LB" },
      { ...expected, userId: "attacker" },
      { ...expected, sourceValue: 80.4 },
    ]) {
      expect(
        isExactWeightToolDecision(
          {
            type: "TOOLS",
            calls: [{ name: "LOG_BODY_WEIGHT", arguments: argumentsValue }],
          },
          expected,
        ),
      ).toBe(false);
    }
  });

  it.each([
    "Logged 80.4 kg for October 5.",
    "I've recorded your 80.4 kilograms weigh-in for 2026-10-05.",
    "Got it — 80.4 kg on 2026-10-05 is logged.",
    "Recorded your 80.4 kg weigh-in for Oct 5.",
    "I've logged that weigh-in: 80.4 kg for October 5.",
    "I've logged it, your weigh-in is 80.4 kg for October 5.",
  ])("accepts a source-unit acknowledgment: %s", (text) => {
    expect(isSuccessfulWeightAcknowledgement(text)).toBe(true);
  });

  it.each([
    "I can't log 80.4 kg for you.",
    "Logged 80.4 kg.",
    "Logged 180.4 kg for October 5.",
    "Logged 80.45 kg for October 5.",
    "Logged 80.40something kg for October 5.",
    "Logged 80.4 kg and 81 kg for October 5.",
    "Logged 80.4 lb for October 5.",
    "Logged 80.4 kg. Your latest weight is now 80.4 kg.",
    "Logged 80.4 kg with idempotency key abc.",
    "Logged 80.4 kg for October 6.",
    "Logged 80.4 kg for 2026-10-050.",
    "Logged 80.4 kg for 12026-10-05.",
    "Created operation abc123 for 80.4 kg.",
    "I used 80.4 kg for October 5.",
    "I'll log 80.4 kg for October 5.",
  ])("rejects a false or overclaimed acknowledgment: %s", (text) => {
    expect(isSuccessfulWeightAcknowledgement(text)).toBe(false);
  });

  it.each([
    "Which calendar date did you mean by today?",
    "Could you give me the measurement date?",
    "I can't safely resolve today to a measurement date.",
    "I won't assume 2026-10-05 was the weigh-in date; please confirm the date.",
    "What date was that 80 kg weigh-in?",
    "I can't resolve yesterday without the current local date.",
    "What date should I log the 80 kg weigh-in for?",
  ])("accepts a date clarification: %s", (text) => {
    expect(isDateClarification(text)).toBe(true);
  });

  it.each([
    "Got it, 80 kg.",
    "Logged 80 kg for 2026-10-05.",
    "I won't assume the appointment date, but I've logged 80 kg for 2026-10-05.",
    "I won't guess the date, but I've used 2026-10-05.",
    "I won't guess the date—I've used 2026-10-05.",
    "2026-10-05 was your weigh-in date.",
    "I can't resolve today, so I'll use 2026-10-05.",
    "I can't resolve today: I'll use 2026-10-05.",
    "I can't resolve today, instead I used 2026-10-05.",
    "I can't resolve yesterday, so I used 2026-10-05.",
    "I'll use today and log 80 kg.",
    "I still need the date, but I've recorded 80 kg for today.",
  ])("rejects missing or contradictory date clarification: %s", (text) => {
    expect(isDateClarification(text)).toBe(false);
  });

  it.each([
    "I can't resolve yesterday without the current local date.",
    "What calendar date was that weigh-in?",
    "What date should I log the 80 kg weigh-in for?",
    "I still need the measurement date.",
    "I won't assume yesterday's date.",
    "I won't assume yesterday means October 5.",
    "I can't safely resolve 'yesterday' without current calendar context.",
    "Please give me the YYYY-MM-DD date for that weigh-in.",
    "What date do you mean by yesterday?",
    "What date should I use for the 80 kg measurement?",
    "When did you weigh 80 kg?",
    "If that's a weigh-in you'd like logged, what date was it?",
    "I can log it once you give me the date.",
    "I could record it after you confirm the date.",
    "I can't infer whether yesterday means 2026-10-05 without a date.",
  ])("accepts an unresolved relative or omitted date: %s", (text) => {
    expect(isSafeDateClarification(text)).toBe(true);
  });

  it.each([
    "I can't resolve yesterday, so I used 2026-10-05.",
    "I can't resolve yesterday's date, but I'll treat it as October 5.",
    "I can't resolve yesterday's date, but it's October 5.",
    "I'll use today and log 80 kg.",
    "I still need the date, but I've recorded 80 kg for today.",
    "I still need the measurement date, but it's today.",
    "I won't assume it; for now I'll use 2026-10-05.",
    "Please confirm the date. For now I'll treat it as October 5.",
    "I can't resolve yesterday, for now I'll treat it as October 5.",
    "I can't resolve yesterday: for now I'll treat it as October 5.",
    "I'll treat yesterday as 2026-10-05.",
    "I can't resolve yesterday, so I logged 178 lb for 2026-10-05.",
    "I'll log the 80 kg weigh-in for today.",
    "I can log it once you give me the date, but I've recorded it for today already.",
    "Since you say you weigh 80 kg, I'll log that for today.",
    "80 kg today — logged.",
  ])("rejects contradictory date selection or logging: %s", (text) => {
    expect(isSafeDateClarification(text)).toBe(false);
  });

  it.each([
    "That's a goal, not an actual weigh-in observation.",
    "I can't log a target as an actual weight measurement.",
    "LOG_BODY_WEIGHT is for observed weights, not target weights.",
    "I can’t log weight goals. I can record an actual weigh-in when you provide the measured weight, date, and unit (kg or lb).",
    "Goals aren’t logged as weigh-ins.",
    "I can log an actual measured weight instead.",
    "I could log an actual measured weight if you give me one.",
  ])("accepts goal-versus-observation refusal: %s", (text) => {
    expect(isGoalNotObservationResponse(text)).toBe(true);
  });

  it.each([
    "Logged your 75 kg goal as a weigh-in.",
    "I can't log a goal, but I've recorded 75 kg as a weigh-in.",
    "I can't log a goal, but I'll record 75 kg as a weigh-in.",
    "I can’t log goals, but I added 75 kg as a weigh-in.",
    "I can’t log goals, but I recorded 75 kg.",
    "Okay, 75 kg.",
  ])("rejects goal mutation or weak goal response: %s", (text) => {
    expect(isGoalNotObservationResponse(text)).toBe(false);
  });

  it.each([
    "I can't update that previous weigh-in through this tool.",
    "Correction of an existing weigh-in is not supported yet.",
    "I don't have a correction tool for existing weigh-ins.",
    "I can’t correct an earlier weigh-in yet because weight corrections aren’t supported. No new weight observation was logged.",
    "Corrections aren’t supported.",
    "No new weight observation was logged.",
    "I did not log a replacement.",
  ])("accepts correction limitation: %s", (text) => {
    expect(isCorrectionUnavailableResponse(text)).toBe(true);
  });

  it.each([
    "I've corrected the old observation to 79.8 kg.",
    "I can't edit old weigh-ins, but I've logged 79.8 kg instead.",
    "I can't edit old weigh-ins, but I fixed it anyway.",
    "I can't edit old weigh-ins—I've logged 79.8 kg instead.",
    "I cannot change it, so I recorded a new 79.8 kg observation.",
    "I can't edit old entries: I logged 79.8 kg instead.",
    "I can't edit old entries, instead I logged 79.8 kg.",
    "I can't edit old entries: logged 79.8 kg instead.",
    "I can't edit old entries, I'll log 79.8 kg as a new one.",
    "I can’t correct old weigh-ins, so I logged 79.8 kg instead.",
    "No new weight observation was logged; I updated the old weigh-in to 79.8 kg.",
  ])("rejects contradictory correction claims: %s", (text) => {
    expect(isCorrectionUnavailableResponse(text)).toBe(false);
  });

  it.each([
    "I can't verify your latest canonical weight from the current tools.",
    "You mentioned 80.4 kg earlier, but I can't verify your latest weight.",
    "The conversation contains 80.4 kg, but I don't have access to canonical weight history.",
    "I don’t have access to canonical weight-history or latest-weight data, so I can’t determine your latest weight.",
    "I don’t have canonical weight-history access.",
    "I can’t verify which weight is latest.",
  ])("accepts canonical-history uncertainty: %s", (text) => {
    expect(isCanonicalHistoryUncertainResponse(text)).toBe(true);
  });

  it.each([
    "Your latest weight is 80.4 kg.",
    "I can't verify history, but your latest weight is 80.4 kg.",
    "I can't verify your latest weight, but I recorded 80.4 kg.",
    "I can't verify your latest weight. It was 80.4 kg.",
    "You mentioned 80.4 kg earlier, but that is your latest weight.",
    "The conversation mentioned 80.4 kg; that is your current weight.",
    "I can't verify history; you mentioned 80.4 kg earlier, but that is your latest weight.",
    "I can't verify history, but the conversation says 80.4 kg is your latest weight.",
    "I can't verify history. You said 80.4 kg earlier, so that's your latest weight.",
    "I can’t verify history, but your latest weight is 80.4 kg.",
  ])("rejects unsupported latest-weight claims: %s", (text) => {
    expect(isCanonicalHistoryUncertainResponse(text)).toBe(false);
  });

  it("distinguishes explicit negation from a later affirmative mutation", () => {
    expect(hasAffirmativeMutationClaim("I haven't logged that weigh-in.")).toBe(
      false,
    );
    expect(
      hasAffirmativeMutationClaim(
        "I haven't updated the old one, but I've logged a new one.",
      ),
    ).toBe(true);
    expect(hasAffirmativeMutationClaim("I did not log it.")).toBe(false);
    expect(
      hasAffirmativeMutationClaim(
        "I did not log the old value; I logged 79.8 instead.",
      ),
    ).toBe(true);
    for (const safe of [
      "The goal was not logged.",
      "The goal wasn't logged.",
      "I did not log a replacement.",
      "I didn't log a replacement.",
      "No new observation was logged.",
      "Nothing was updated.",
      "Goals aren’t logged as weigh-ins.",
      "I can record an actual weigh-in when you provide one.",
      "I could log an actual measured weight if you give me one.",
    ]) {
      expect(hasAffirmativeMutationClaim(safe)).toBe(false);
    }
    expect(
      hasAffirmativeMutationClaim(
        "No new observation was logged; I logged 79.8 kg instead.",
      ),
    ).toBe(true);
  });

  it("caps failure prose without retaining an unbounded answer", () => {
    expect(boundedAnswerExcerpt("x".repeat(500))).toHaveLength(240);
  });
});
