/** Eval-only synthetic tool-result flow; never executes a backend mutation or read. */
import type {
  FoodDayModelFinalizationInput,
  FoodDayTurnModel,
} from "../agent/turn/food-day-turn-types.js";
import type { HistoryEvalScenario } from "./body-weight-history-eval-fixtures.js";
import { isExactHistoryReadContinuation } from "./body-weight-history-eval-assertions.js";

export class HistoryEvalFlowMismatch extends Error {
  override readonly name = "HistoryEvalFlowMismatch";

  constructor(
    readonly expectedStep: "GET_BODY_WEIGHT_HISTORY({})" | "FINAL",
    readonly actualStep: object,
  ) {
    super("Post-tool model step did not match the required eval flow.");
  }
}

function stepSummary(step: unknown): object {
  if (step === null || typeof step !== "object") return { type: "OTHER" };
  const value = step as Record<string, unknown>;
  if (value.type === "FINAL") return { type: "FINAL" };
  if (value.type !== "READ_TOOL") return { type: "OTHER" };
  const call = value.call;
  if (call === null || typeof call !== "object") {
    return { type: "READ_TOOL", tool: "OTHER_TOOL" };
  }
  const readCall = call as Record<string, unknown>;
  const args = readCall.arguments;
  const keys =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args)
      : [];
  return {
    type: "READ_TOOL",
    tool:
      readCall.name === "GET_BODY_WEIGHT_HISTORY" ||
      readCall.name === "LOG_BODY_WEIGHT"
        ? readCall.name
        : "OTHER_TOOL",
    argumentCount: keys.length,
    recognizedArgumentKeys: keys.filter((key) =>
      ["limit", "userId", "localDate", "currentLocalDate", "cursor"].includes(
        key,
      ),
    ),
  };
}

export async function completeHistoryEvalTurn(
  model: Pick<FoodDayTurnModel, "finalizeOrRead" | "finalize">,
  scenario: HistoryEvalScenario,
  input: Omit<FoodDayModelFinalizationInput, "toolResults">,
  initialLogOnly: boolean,
  onPhase?: (phase: "POST_TOOL" | "FINAL_FINALIZATION") => void,
): Promise<{ readonly answer: string; readonly modelCalls: 1 | 2 }> {
  if (!scenario.toolResults) {
    throw new Error("Missing fabricated eval tool results.");
  }
  const initialResults = structuredClone(
    scenario.id === "H"
      ? scenario.toolResults.slice(0, 2)
      : initialLogOnly
        ? scenario.toolResults.slice(0, 1)
        : scenario.toolResults,
  );
  onPhase?.("POST_TOOL");
  const firstStep = await model.finalizeOrRead({
    ...input,
    toolResults: initialResults,
  });
  if (scenario.id === "H" || initialLogOnly) {
    if (!isExactHistoryReadContinuation(firstStep)) {
      throw new HistoryEvalFlowMismatch(
        "GET_BODY_WEIGHT_HISTORY({})",
        stepSummary(firstStep),
      );
    }
    const freshRead = scenario.toolResults.at(-1);
    if (freshRead?.name !== "GET_BODY_WEIGHT_HISTORY") {
      throw new Error("Missing fabricated fresh eval history result.");
    }
    onPhase?.("FINAL_FINALIZATION");
    return {
      answer: await model.finalize({
        ...input,
        toolResults: [...initialResults, structuredClone(freshRead)],
      }),
      modelCalls: 2,
    };
  }
  if (firstStep.type !== "FINAL") {
    throw new HistoryEvalFlowMismatch("FINAL", stepSummary(firstStep));
  }
  return { answer: firstStep.text, modelCalls: 1 };
}
