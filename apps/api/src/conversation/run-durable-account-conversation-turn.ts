import type { ExecuteAccountConversationPlanDependencies } from "./execute-account-conversation-plan.js";
import { executeAccountConversationPlan } from "./execute-account-conversation-plan.js";
import type { FinalizeAccountConversationTurnDependencies } from "./finalize-account-conversation-turn.js";
import { finalizeAccountConversationTurn } from "./finalize-account-conversation-turn.js";
import type {
  AccountConversationPlanningTurnResult,
  RunAccountConversationPlanningTurnDependencies,
} from "./run-account-conversation-planning-turn.js";
import { runAccountConversationPlanningTurn } from "./run-account-conversation-planning-turn.js";
import type { RunAccountConversationTurnRequest } from "./run-account-conversation-turn.js";

export interface RunDurableAccountConversationTurnDependencies {
  readonly planning: RunAccountConversationPlanningTurnDependencies;
  readonly execution: ExecuteAccountConversationPlanDependencies;
  readonly finalization: FinalizeAccountConversationTurnDependencies;
}

export type DurableAccountConversationTurnResult =
  | { readonly kind: "COMPLETED"; readonly response: string }
  | Exclude<
      AccountConversationPlanningTurnResult,
      { kind: "PLAN_READY" | "COMPLETED_REPLAY" }
    >;

/** Compose durable stage boundaries without spanning model IO with a transaction.
 * Planning owns claim/routing/preparation; execution owns unfinished plan slots;
 * finalization owns exact public response completion. */
export async function runDurableAccountConversationTurn(
  dependencies: RunDurableAccountConversationTurnDependencies,
  request: RunAccountConversationTurnRequest,
): Promise<DurableAccountConversationTurnResult> {
  const planned = await runAccountConversationPlanningTurn(
    dependencies.planning,
    request,
  );
  if (planned.kind === "COMPLETED_REPLAY") {
    return { kind: "COMPLETED", response: planned.response };
  }
  if (planned.kind !== "PLAN_READY") return planned;

  // M5A1 normalizes the verified UUID before persisting the claim. Preserve
  // that canonical owner spelling across strict checkpoint hydration.
  const input = {
    trustedUserId: request.trustedUserId.toLowerCase(),
    turnId: planned.turnId,
  };
  if (planned.plan.slots[0]?.action !== "DIRECT_RESPONSE") {
    // Count only. Each stage retains its own strict result/plan validation.
    // A full durable prefix goes directly to finalization; an incomplete one
    // resumes at the first unfinished ordinal inside M5A8C.
    const saved = await dependencies.finalization.stepResults.listForTurn(
      input.trustedUserId,
      input.turnId,
    );
    if (saved.length !== planned.plan.slots.length) {
      const executed = await executeAccountConversationPlan(
        dependencies.execution,
        input,
      );
      if (executed.kind === "COMPLETED_REPLAY") {
        return { kind: "COMPLETED", response: executed.response };
      }
    }
  }
  const completed = await finalizeAccountConversationTurn(
    dependencies.finalization,
    input,
  );
  return { kind: "COMPLETED", response: completed.response };
}
