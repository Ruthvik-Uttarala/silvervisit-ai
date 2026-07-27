import { randomUUID } from "node:crypto";
import { ServerResponse } from "node:http";
import { planNextAction } from "../actionPlanner";
import { AppConfig } from "../types";
import { AppRepository } from "../repository";
import { Logger } from "../logger";
import { sendJson } from "../utils";

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lKsAAAAASUVORK5CYII=";

export async function handleIntegrationSelfTest(
  res: ServerResponse,
  requestId: string,
  config: AppConfig,
  repository: AppRepository,
  logger: Logger,
): Promise<void> {
  const diagnostics = repository.getDiagnostics();
  if (!diagnostics.configured || !diagnostics.runtimeReady) {
    sendJson(res, 503, { ok: false, stage: "repository", diagnostics }, requestId);
    return;
  }

  const fixtureResponse = await repository.getFixtureBySeed(2);
  const fixture = fixtureResponse.fixture;
  const sessionId = randomUUID();
  const userGoal = "Help me join my doctor appointment today.";

  await repository.upsertNavigatorSession(sessionId, userGoal, {
    source: "production_self_test",
    synthetic: true,
  });

  const run = await repository.startSandboxRun({
    seed: 2,
    source: "extension",
    navigatorSessionId: sessionId,
  });

  await repository.appendSandboxRunEvent({
    runId: run.runId,
    step: "production_self_test",
    eventType: "integration_probe",
    metadata: { synthetic: true },
  });

  const elements = [
    {
      id: "details-start-echeckin-btn",
      text: "Start eCheck-In",
      role: "button",
      x: 100,
      y: 320,
      width: 220,
      height: 48,
      visible: true,
      enabled: true,
    },
    {
      id: "details-open-device-setup-btn",
      text: "Open Device Setup",
      role: "button",
      x: 100,
      y: 390,
      width: 220,
      height: 48,
      visible: true,
      enabled: true,
    },
    {
      id: "cancel-appointment-btn",
      text: "Cancel appointment",
      role: "button",
      x: 100,
      y: 460,
      width: 220,
      height: 48,
      visible: true,
      enabled: true,
    },
  ];

  const plan = await planNextAction(
    {
      sessionId,
      userGoal,
      pageUrl: "https://silvervisit-ai.vercel.app/?seed=2",
      pageTitle: "SilverVisit appointment details",
      visibleText: [
        "SilverVisit Virtual Clinic",
        "Today at 1:30 PM",
        "Dr. Naomi Patel - Video Check-in",
        "eCheck-In is required before joining",
        "Start eCheck-In",
        "Open Device Setup",
      ],
      elements,
      requireScreenshot: true,
      screenshotBase64: tinyPng,
      screenshotMimeType: "image/png",
      sandboxFixture: fixture,
    },
    {
      config,
      logger,
      requestId,
      recentHistory: [],
    },
  );

  const allowedIds = new Set(elements.map((element) => element.id));
  const targetGrounded = !plan.action.targetId || allowedIds.has(plan.action.targetId);
  const matchedIdsGrounded = plan.grounding.matchedElementIds.every((id) => allowedIds.has(id));
  const safeAction = plan.action.targetId !== "cancel-appointment-btn";
  const plannerPassed = plan.status !== "error" && targetGrounded && matchedIdsGrounded && safeAction;

  await repository.recordActionLog(sessionId, {
    requestId,
    userGoal,
    pageUrl: "https://silvervisit-ai.vercel.app/?seed=2",
    pageTitle: "SilverVisit appointment details",
    action: plan.action,
    status: plan.status,
    confidence: plan.confidence,
    grounding: plan.grounding,
  });

  sendJson(
    res,
    plannerPassed ? 200 : 500,
    {
      ok: plannerPassed,
      provider: config.aiProvider,
      model: config.geminiActionModel,
      databaseProvider: diagnostics.provider,
      fixtureSeed: fixtureResponse.seed,
      sessionPersisted: true,
      runPersisted: true,
      eventPersisted: true,
      plan: {
        status: plan.status,
        actionType: plan.action.type,
        targetId: plan.action.targetId ?? null,
        confidence: plan.confidence,
        targetGrounded,
        matchedIdsGrounded,
        safeAction,
      },
    },
    requestId,
  );
}
