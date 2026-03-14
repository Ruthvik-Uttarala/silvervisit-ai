import { ServerResponse } from "node:http";
import { planNextAction } from "../actionPlanner";
import { AppConfig, PlanActionResponse } from "../types";
import { Logger } from "../logger";
import { SessionStore } from "../sessions";
import { nowIso, sendJson } from "../utils";
import { validatePlanActionRequest } from "../validation/requestValidation";

export function buildPlanActionErrorResponse(
  message: string,
  status: PlanActionResponse["status"] = "error",
): PlanActionResponse {
  return {
    status,
    message,
    action: {
      type: "ask_user",
    },
    confidence: status === "error" ? 0 : 0.2,
    grounding: {
      matchedElementIds: [],
      matchedVisibleText: [],
      reasoningSummary: message,
    },
  };
}

export async function handlePlanAction(
  res: ServerResponse,
  body: unknown,
  requestId: string,
  sessions: SessionStore,
  config: AppConfig,
  log: Logger,
): Promise<void> {
  const validation = validatePlanActionRequest(body);

  if (!validation.ok) {
    const payload = buildPlanActionErrorResponse(validation.message, "error");
    sendJson(res, validation.statusCode, payload, requestId);
    return;
  }

  const request = validation.value;
  const session = sessions.upsertSession(request.sessionId, request.userGoal);

  sessions.appendHistory(session.sessionId, {
    timestamp: nowIso(),
    type: "plan_request",
    summary: `Goal=${request.userGoal.slice(0, 120)}`,
  });

  const response = await planNextAction(request, {
    config,
    logger: log,
    requestId,
    recentHistory: sessions.listRecentHistory(session.sessionId, 5),
  });

  sessions.appendHistory(session.sessionId, {
    timestamp: nowIso(),
    type: "plan_response",
    summary: `${response.status}:${response.action.type}`,
  });

  log.info("Plan action completed", {
    requestId,
    sessionId: session.sessionId,
    status: response.status,
    actionType: response.action.type,
    confidence: response.confidence,
  });

  sendJson(res, 200, response, requestId);
}
