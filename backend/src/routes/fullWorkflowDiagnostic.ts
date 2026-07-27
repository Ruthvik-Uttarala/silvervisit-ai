import { randomUUID } from "node:crypto";
import { ServerResponse } from "node:http";
import { planNextAction, resolveObviousNextActionForTesting } from "../actionPlanner";
import { loadConfig } from "../config";
import { parseNavigatorIntent } from "../intentParser";
import { logger } from "../logger";
import { getRepository } from "../repository";
import { PlanActionRequest, SessionEvent, UIElement } from "../types";
import { sendJson, safeErrorMessage } from "../utils";

interface DiagnosticStage {
  key: string;
  title: string;
  copy: string;
  expectedTargetId: string;
  buttons: Array<{ id: string; text: string }>;
}

const stages: DiagnosticStage[] = [
  { key: "pre_check_in", title: "Today at 1:30 PM", copy: "eCheck-In is required before joining.", expectedTargetId: "details-start-echeckin-btn", buttons: [{ id: "details-start-echeckin-btn", text: "Start eCheck-In" }, { id: "cancel-appointment-btn", text: "Cancel appointment" }] },
  { key: "echeckin_in_progress", title: "eCheck-In", copy: "The fictional patient information is ready. Finish eCheck-In to continue.", expectedTargetId: "echeckin-finish-btn", buttons: [{ id: "echeckin-finish-btn", text: "Finish eCheck-In" }, { id: "echeckin-cancel-btn", text: "Cancel eCheck-In" }] },
  { key: "device_setup", title: "Device setup", copy: "Camera and microphone checks are complete. Continue to waiting room.", expectedTargetId: "finish-device-test-btn", buttons: [{ id: "finish-device-test-btn", text: "Continue to waiting room" }, { id: "device-cancel-visit-btn", text: "Cancel visit" }] },
  { key: "provider_ready", title: "Provider is ready", copy: "Enter the secure video call.", expectedTargetId: "enter-call-btn", buttons: [{ id: "enter-call-btn", text: "Enter Call" }, { id: "provider-leave-room-btn", text: "Leave waiting room" }] },
];

export async function handleFullWorkflowDiagnostic(res: ServerResponse, requestId: string): Promise<void> {
  const config = loadConfig();
  const repository = getRepository(config);
  const goal = "Help me join my doctor appointment today.";
  const sessionId = randomUUID();
  const history: SessionEvent[] = [];
  const parsedIntent = parseNavigatorIntent(goal);

  try {
    const fixtureResult = await repository.getFixtureBySeed(2);
    await repository.upsertNavigatorSession(sessionId, goal, { source: "full_workflow_diagnostic" });
    const run = await repository.startSandboxRun({ seed: 2, source: "sandbox", navigatorSessionId: sessionId });
    const results: Array<Record<string, unknown>> = [];

    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      const elements: UIElement[] = stage.buttons.map((button, elementIndex) => ({
        id: button.id,
        text: button.text,
        role: "button",
        x: 100,
        y: 260 + elementIndex * 60,
        width: 220,
        height: 48,
        visible: true,
        enabled: true,
      }));
      const fixture = JSON.parse(JSON.stringify(fixtureResult.fixture));
      fixture.portalState = stage.key;
      const request: PlanActionRequest = {
        sessionId,
        userGoal: goal,
        pageUrl: "https://silvervisit-api.vercel.app/demo",
        pageTitle: "SilverVisit AI Demo",
        visibleText: ["SilverVisit Virtual Clinic", stage.title, stage.copy, ...stage.buttons.map((button) => button.text)],
        elements,
        sandboxFixture: fixture,
      };
      const stepRequestId = `${requestId}-${index + 1}`;
      const engine = index === 0 ? "gemini" : "safety_engine";
      const plan = index === 0
        ? await planNextAction(request, { config, logger, requestId: stepRequestId, recentHistory: history })
        : resolveObviousNextActionForTesting(request, parsedIntent);

      if (!plan) {
        sendJson(res, 500, { ok: false, sessionId, runId: run.runId, completedSteps: index, failedStep: index + 1, error: "Safety engine found no grounded next action.", results }, requestId);
        return;
      }

      const actualTargetId = plan.action.targetId ?? "";
      const passed = plan.status === "ok" && plan.action.type === "click" && actualTargetId === stage.expectedTargetId;
      results.push({ step: index + 1, stage: stage.key, engine, expectedTargetId: stage.expectedTargetId, actualTargetId, actionType: plan.action.type, status: plan.status, confidence: plan.confidence, passed });
      await repository.recordActionLog(sessionId, { requestId: stepRequestId, userGoal: goal, pageUrl: request.pageUrl, pageTitle: request.pageTitle, action: plan.action, status: plan.status, confidence: plan.confidence, grounding: plan.grounding });
      await repository.appendSandboxRunEvent({ runId: run.runId, step: stage.key, eventType: "diagnostic_action", metadata: { engine, expectedTargetId: stage.expectedTargetId, actualTargetId, passed } });
      history.push({ timestamp: new Date().toISOString(), type: "plan_response", summary: `${engine}:${plan.action.type}:${actualTargetId}` });
      if (!passed) {
        sendJson(res, 500, { ok: false, sessionId, runId: run.runId, completedSteps: index, failedStep: index + 1, results }, requestId);
        return;
      }
    }

    sendJson(res, 200, { ok: true, sessionId, runId: run.runId, completedSteps: stages.length, finalState: "joined", architecture: "gemini_intent_plus_deterministic_safety_engine", results }, requestId);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: safeErrorMessage(error) }, requestId);
  }
}
