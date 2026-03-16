import type { ActionObject, PlanActionResponse } from "./types";

export interface GoalCompletionResult {
  complete: boolean;
  evidence: string;
}

export function isJoinGoalText(goal: string): boolean {
  const normalized = goal.toLowerCase();
  return /\b(join|appointment|check ?in|waiting room|visit|enter call)\b/.test(normalized);
}

function hasJoinedEvidence(visibleText: string): boolean {
  return /\byou have joined\b|\bjoined the visit\b|\bin call\b|\bvisit connected\b/.test(visibleText);
}

export function evaluateGoalCompletion(
  goal: string,
  visibleTextLines: string[],
  plan: Pick<PlanActionResponse, "status" | "action">,
): GoalCompletionResult {
  const visible = visibleTextLines.join(" ").toLowerCase();

  if (isJoinGoalText(goal)) {
    if (hasJoinedEvidence(visible)) {
      return { complete: true, evidence: "Joined-call evidence is visible on the page." };
    }
    return {
      complete: false,
      evidence: "Join goal is still in prerequisite progression (not yet joined).",
    };
  }

  const nonJoinItemGoal =
    /\b(report|result|referral|prescription|message|note|avs|after visit|past visit)\b/.test(
      goal.toLowerCase(),
    );
  const hasItemEvidence =
    /detail|summary|return to related appointment|message thread|linked appointment/i.test(visible);

  if (nonJoinItemGoal && hasItemEvidence) {
    return { complete: true, evidence: "Requested detail/item evidence is visible." };
  }

  if (plan.status === "ok" && (plan.action as ActionObject).type === "done" && hasItemEvidence) {
    return { complete: true, evidence: "Planner returned done with visible destination evidence." };
  }

  return { complete: false, evidence: "Final goal evidence not visible yet." };
}

