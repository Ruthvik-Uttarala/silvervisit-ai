export type GoalStatus = "pending" | "in_progress" | "blocked" | "completed" | "fallback_used";

export interface GoalItem {
  id: string;
  text: string;
  fingerprint: string;
  status: GoalStatus;
  fallbackUsed: boolean;
  completionEvidence?: string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeGoalFingerprint(value: string): string {
  return normalizeWhitespace(value).toLowerCase().slice(0, 600);
}

export function splitGoals(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }
  const parts = raw
    .split(/[\n;]+/g)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length > 0);
  return [...new Set(parts)];
}

function buildGoalId(text: string, index: number): string {
  const fingerprint = normalizeGoalFingerprint(text).replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "goal";
  return `${fingerprint}-${index + 1}`;
}

export function buildGoalQueue(raw: string): GoalItem[] {
  const goals = splitGoals(raw);
  return goals.map((text, index) => ({
    id: buildGoalId(text, index),
    text,
    fingerprint: normalizeGoalFingerprint(text),
    status: "pending",
    fallbackUsed: false,
  }));
}

export function serializePendingGoals(goals: GoalItem[]): string {
  return goals
    .filter((goal) => goal.status !== "completed")
    .map((goal) => goal.text)
    .join(";\n");
}

export function getActiveGoal(goals: GoalItem[]): GoalItem | null {
  return goals.find((goal) => goal.status !== "completed") ?? null;
}

export function updateGoalStatus(
  goals: GoalItem[],
  goalId: string,
  nextStatus: GoalStatus,
  options?: { fallbackUsed?: boolean; completionEvidence?: string },
): GoalItem[] {
  return goals.map((goal) => {
    if (goal.id !== goalId) {
      return goal;
    }
    return {
      ...goal,
      status: nextStatus,
      fallbackUsed: options?.fallbackUsed ?? goal.fallbackUsed,
      completionEvidence: options?.completionEvidence ?? goal.completionEvidence,
    };
  });
}

export function removeCompletedGoals(goals: GoalItem[]): GoalItem[] {
  return goals.filter((goal) => goal.status !== "completed");
}

