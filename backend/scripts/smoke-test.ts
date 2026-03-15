import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { enforcePlannerGuardrailsForTesting } from "../src/actionPlanner";
import { isVertexConfigured, loadConfig } from "../src/config";
import { parseNavigatorIntent } from "../src/intentParser";
import { startServer } from "../src/server";
import { PlanActionRequest, PlanActionResponse } from "../src/types";

const ACTION_TYPES = new Set(["highlight", "click", "type", "scroll", "wait", "ask_user", "done"]);

function readFixtureJson(filePath: string): any {
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

function validatePlanActionShape(payload: any): void {
  assert.equal(typeof payload, "object");
  assert.ok(["ok", "need_clarification", "error"].includes(payload.status), "invalid status");
  assert.equal(typeof payload.message, "string");

  assert.equal(typeof payload.action, "object");
  assert.ok(ACTION_TYPES.has(payload.action.type), "invalid action.type");

  if (payload.action.targetId !== undefined) {
    assert.equal(typeof payload.action.targetId, "string");
  }
  if (payload.action.value !== undefined) {
    assert.equal(typeof payload.action.value, "string");
  }
  if (payload.action.direction !== undefined) {
    assert.ok(["up", "down", "left", "right"].includes(payload.action.direction));
  }
  if (payload.action.amount !== undefined) {
    assert.ok(["small", "medium", "large"].includes(payload.action.amount));
  }
  if (payload.action.delayMs !== undefined) {
    assert.equal(typeof payload.action.delayMs, "number");
  }

  assert.equal(typeof payload.confidence, "number");
  assert.ok(payload.confidence >= 0 && payload.confidence <= 1, "confidence out of range");

  assert.equal(typeof payload.grounding, "object");
  assert.ok(Array.isArray(payload.grounding.matchedElementIds));
  assert.ok(Array.isArray(payload.grounding.matchedVisibleText));
  assert.equal(typeof payload.grounding.reasoningSummary, "string");
}

function validateGroundingAgainstRequest(payload: any, request: any): void {
  const elementMap = new Map<string, any>(
    Array.isArray(request.elements)
      ? request.elements
          .filter((element: any) => element && typeof element.id === "string")
          .map((element: any) => [element.id, element])
      : [],
  );
  const visibleTextSet = new Set<string>(Array.isArray(request.visibleText) ? request.visibleText : []);

  for (const id of payload.grounding.matchedElementIds as string[]) {
    assert.ok(elementMap.has(id), `grounding.matchedElementIds contains unknown id: ${id}`);
  }

  for (const text of payload.grounding.matchedVisibleText as string[]) {
    assert.ok(visibleTextSet.has(text), `grounding.matchedVisibleText contains unknown text: ${text}`);
  }

  if (payload.action.targetId !== undefined) {
    const target = elementMap.get(payload.action.targetId);
    assert.ok(target, "action.targetId must exist in request.elements");
    if (["click", "type"].includes(payload.action.type)) {
      assert.notEqual(target.visible, false, "executable target cannot be hidden");
      assert.notEqual(target.enabled, false, "executable target cannot be disabled");
    }
  }

  const hasGroundingSignal =
    payload.grounding.matchedElementIds.length > 0 || payload.grounding.matchedVisibleText.length > 0;
  if (payload.status === "ok" && payload.action.type !== "ask_user") {
    assert.ok(hasGroundingSignal, "successful executable action must include grounded evidence");
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
  });
}

async function waitForMessage(messages: any[], startIndex: number, timeoutMs: number): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (messages.length > startIndex) {
      return messages[messages.length - 1];
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for WebSocket message");
}

async function waitForMessageMatching(
  messages: any[],
  startIndex: number,
  timeoutMs: number,
  matcher: (message: any) => boolean,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (let i = startIndex; i < messages.length; i += 1) {
      if (matcher(messages[i])) {
        return messages[i];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for expected WebSocket message");
}

function hasAdcConfigured(): boolean {
  const explicitPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return true;
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".config", "gcloud", "application_default_credentials.json"),
    path.join(home, "AppData", "Roaming", "gcloud", "application_default_credentials.json"),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function printVertexStatus(planActionResponse: any, requestFixture: any, label: string): void {
  const runtimeConfig = loadConfig();
  const missing: string[] = [];
  if (!runtimeConfig.useVertexAI) {
    missing.push("GOOGLE_GENAI_USE_VERTEXAI=true");
  }
  if (!runtimeConfig.googleCloudProject) {
    missing.push("GOOGLE_CLOUD_PROJECT");
  }
  if (!runtimeConfig.googleCloudLocation) {
    missing.push("GOOGLE_CLOUD_LOCATION");
  }
  if (!isVertexConfigured(runtimeConfig)) {
    missing.push("Vertex configuration");
  }
  if (!hasAdcConfigured()) {
    missing.push("Application Default Credentials");
  }

  if (missing.length > 0) {
    console.log(`[smoke] Vertex real-call skipped because missing prerequisites: ${missing.join(", ")}.`);
    console.log(
      "[smoke] To enable real Vertex checks, set env vars and run: gcloud auth application-default login",
    );
    return;
  }

  assert.notEqual(
    planActionResponse.status,
    "error",
    `Expected a real Vertex planning result for ${label}, got status=error: ${planActionResponse.message}`,
  );
  validateGroundingAgainstRequest(planActionResponse, requestFixture);

  console.log(`[smoke] Real Vertex Gemini planning call succeeded for ${label} and grounding checks passed.`);
  console.log(`[smoke] Validated ${label} model response: ${JSON.stringify(planActionResponse)}`);
}

function buildSeededPlannerFixturesFromRecords(
  baseFixture: any,
  fixtureRecords: Array<{ seed: number; fixture: any }>,
): Array<{ seed: number; payload: any }> {
  return fixtureRecords.map((record) => {
    const seed = record.seed;
    const fixture = record.fixture;
    const primaryAppointment = Array.isArray(fixture.appointments)
      ? fixture.appointments.find((item: any) => item?.joinableNow) ?? fixture.appointments[0]
      : null;
    const doctorName = primaryAppointment?.providerName ?? fixture.doctorName ?? "Care Team";
    const visitType = primaryAppointment?.visitType ?? fixture.appointmentType ?? "Telehealth Visit";
    const appointmentTime = fixture.appointmentTimeText ?? "Today";
    const visibleText = [
      `${fixture.patientName} telehealth dashboard`,
      appointmentTime,
      `${doctorName} - ${visitType}`,
      "Open Appointment Details",
      "Join Video Visit",
      "Enter Call",
    ];
    return {
      seed,
      payload: {
        ...baseFixture,
        userGoal: `Help ${fixture.patientName} join appointment with ${doctorName}`,
        pageTitle: `${fixture.patientName} - SilverVisit Sandbox`,
        visibleText,
        pageUrl: `${baseFixture.pageUrl}?seed=${seed}`,
        sandboxFixture: fixture,
      },
    };
  });
}

function validateFixtureRealism(seed: number, fixture: any): void {
  assert.equal(typeof fixture.portalNow, "string", `seed ${seed} missing portalNow`);
  assert.ok(Number.isFinite(Date.parse(fixture.portalNow)), `seed ${seed} portalNow is not parseable`);
  assert.ok(Array.isArray(fixture.appointments), `seed ${seed} appointments missing`);
  assert.ok(fixture.appointments.length >= 2, `seed ${seed} needs multiple appointments`);
  assert.ok(Array.isArray(fixture.preVisitTasks) && fixture.preVisitTasks.length >= 3, `seed ${seed} preVisitTasks missing`);
  assert.ok(Array.isArray(fixture.deviceChecks) && fixture.deviceChecks.length >= 3, `seed ${seed} deviceChecks missing`);
  assert.ok(Array.isArray(fixture.supportPaths) && fixture.supportPaths.length >= 5, `seed ${seed} supportPaths missing`);
  assert.ok(
    Array.isArray(fixture.pastVisitSummaries) && fixture.pastVisitSummaries.length >= 1,
    `seed ${seed} pastVisitSummaries missing`,
  );
  assert.ok(Array.isArray(fixture.reportsResults) && fixture.reportsResults.length >= 2, `seed ${seed} reportsResults missing`);
  assert.ok(Array.isArray(fixture.notesAvs) && fixture.notesAvs.length >= 1, `seed ${seed} notesAvs missing`);
  assert.ok(Array.isArray(fixture.messageThreads) && fixture.messageThreads.length >= 2, `seed ${seed} messageThreads missing`);
  assert.ok(Array.isArray(fixture.prescriptions) && fixture.prescriptions.length >= 1, `seed ${seed} prescriptions missing`);
  assert.ok(Array.isArray(fixture.referrals) && fixture.referrals.length >= 1, `seed ${seed} referrals missing`);

  const hasJoinableNow = fixture.appointments.some((item: any) => item?.joinableNow === true);
  const sameDayCount = fixture.appointments.filter((item: any) => String(item?.scheduledDateTime ?? "").startsWith("2026-03-15")).length;
  const hasNotJoinableNow = fixture.appointments.some(
    (item: any) => (item?.status === "today" || item?.status === "upcoming") && item?.joinableNow === false,
  );
  const hasPastLike = fixture.appointments.some((item: any) => item?.status === "past" || item?.status === "completed");

  assert.ok(hasJoinableNow, `seed ${seed} must include at least one joinableNow appointment`);
  if (seed === 2 || seed === 4) {
    assert.ok(sameDayCount >= 2, `seed ${seed} should include multiple same-day appointments`);
    assert.ok(hasNotJoinableNow, `seed ${seed} must include at least one not-yet-joinable appointment`);
  }
  assert.ok(hasPastLike, `seed ${seed} must include at least one past/completed appointment`);

  if (seed === 2) {
    const providers = fixture.appointments.map((item: any) => item?.providerName).join(" | ");
    assert.ok(providers.includes("Naomi") && providers.includes("Naima"), "seed 2 should include Naomi/Naima confusion");
    const topics = fixture.messageThreads.map((item: any) => String(item?.topic ?? "").toLowerCase()).join(" | ");
    assert.ok(topics.includes("asthma"), "seed 2 message threads should include asthma topic for disambiguation");
  }
  if (seed === 4) {
    const providers = fixture.appointments.map((item: any) => item?.providerName).join(" | ");
    assert.ok(providers.includes("Lena") && providers.includes("Lina"), "seed 4 should include Lena/Lina confusion");
  }

  for (const appointment of fixture.appointments) {
    assert.equal(typeof appointment.scheduledDateTime, "string");
    assert.equal(typeof appointment.joinWindowStart, "string");
    assert.equal(typeof appointment.joinWindowEnd, "string");
    assert.equal(typeof appointment.providerName, "string");
    assert.equal(typeof appointment.specialty, "string");
    assert.equal(typeof appointment.visitType, "string");
    assert.equal(typeof appointment.status, "string");
    assert.equal(typeof appointment.joinableNow, "boolean");
  }
}

function runIntentParserRegression(): void {
  const joinGoal =
    "Hello, I am Jennifer Gold my date of birth is 11th May 1947 I need to attend the appointment I have at 3 PM.";
  const joinIntent = parseNavigatorIntent(joinGoal);
  assert.equal(joinIntent.destination, "appointments");
  assert.equal(joinIntent.actionVerb, "join");
  assert.equal(joinIntent.patientName, "Jennifer Gold");
  assert.ok(Boolean(joinIntent.dob), "DOB should be extracted");
  assert.equal(joinIntent.explicitTime?.toLowerCase(), "3 pm");

  const referralGoal =
    "Please take me to the referrals page to see what my general checkup doctor referred me to last week.";
  const referralIntent = parseNavigatorIntent(referralGoal);
  assert.equal(referralIntent.destination, "referrals");
  assert.ok(referralIntent.temporalCues.includes("last_week"));

  const prescriptionGoal = "I need to go to prescriptions from the cholesterol appointment I had yesterday.";
  const prescriptionIntent = parseNavigatorIntent(prescriptionGoal);
  assert.equal(prescriptionIntent.destination, "prescriptions");
  assert.ok(
    prescriptionIntent.temporalCues.includes("yesterday"),
    "yesterday cue should be extracted for prescription goal",
  );
  assert.ok(
    prescriptionIntent.topic?.toLowerCase().includes("cholesterol"),
    "topic extraction should remain generic for appointment-linked prescriptions",
  );

  const noteGoal = "Show me what the doctor wrote after my visit.";
  const noteIntent = parseNavigatorIntent(noteGoal);
  assert.equal(noteIntent.destination, "notes_avs");

  const messageGoal = "Take me to messages from my asthma doctor.";
  const messageIntent = parseNavigatorIntent(messageGoal);
  assert.equal(messageIntent.destination, "messages");
  assert.ok(messageIntent.topic?.toLowerCase().includes("asthma") || messageIntent.specialty?.toLowerCase().includes("asthma"));
}

function runPlannerGuardrailRegression(): void {
  const baseRequest: PlanActionRequest = {
    sessionId: "guardrail-session",
    userGoal: "Take me to messages from my asthma doctor.",
    pageUrl: "http://127.0.0.1:4173/?seed=2",
    pageTitle: "SilverVisit Sandbox",
    visibleText: [
      "Messages",
      "Open Message Thread",
      "Open Referral Details",
      "Waiting Room",
    ],
    elements: [
      {
        id: "message-thread-a-btn",
        text: "Open Message Thread",
        role: "button",
        x: 10,
        y: 10,
        width: 120,
        height: 32,
        visible: true,
        enabled: true,
      },
      {
        id: "message-thread-b-btn",
        text: "Open Message Thread",
        role: "button",
        x: 10,
        y: 60,
        width: 120,
        height: 32,
        visible: true,
        enabled: true,
      },
      {
        id: "referral-item-open-btn",
        text: "Open Referral Details",
        role: "button",
        x: 10,
        y: 110,
        width: 140,
        height: 32,
        visible: true,
        enabled: true,
      },
      {
        id: "hidden-join-btn",
        text: "Join Video Visit",
        role: "button",
        x: 10,
        y: 160,
        width: 140,
        height: 32,
        visible: false,
        enabled: true,
      },
      {
        id: "disabled-name-input",
        text: "Patient name",
        role: "input",
        x: 10,
        y: 210,
        width: 180,
        height: 32,
        visible: true,
        enabled: false,
      },
    ],
    sandboxFixture: {
      fixtureId: "fixture-2",
      seed: 2,
      patientName: "Miguel Thompson",
      patientDob: "04/12/1948",
      loginSecret: "seed-2-pass",
      doctorName: "Dr. Naomi Patel",
      appointmentType: "Cardiology Follow-up",
      clinicLabel: "SilverVisit Heart Center",
      waitingRoomState: "Provider is preparing your room.",
      clinicianReadyState: "Provider is now ready to join.",
      appointmentTimeText: "Today at 3:00 PM",
      visitTitle: "Cardiology Follow-up",
      detailsChecklist: ["Sign in", "Complete eCheck-In", "Run device checks"],
      portalNow: "2026-03-15T14:35:00-05:00",
      portalState: "waiting_room",
      appointments: [
        {
          appointmentId: "apt-joinable",
          scheduledDateTime: "2026-03-15T15:00:00-05:00",
          joinWindowStart: "2026-03-15T14:45:00-05:00",
          joinWindowEnd: "2026-03-15T15:45:00-05:00",
          status: "waiting_room",
          joinableNow: true,
          providerName: "Dr. Naomi Patel",
          specialty: "Cardiology",
          visitType: "Video Follow-up",
          locationLabel: "SilverVisit Heart Center",
        },
      ],
      preVisitTasks: [
        { taskId: "demographics", label: "Confirm demographics", required: true, completed: true, section: "profile" },
      ],
      deviceChecks: [
        { checkId: "camera", label: "Camera test", required: true, passed: true },
      ],
      supportPaths: [
        {
          pathId: "help-join",
          label: "Need help joining",
          description: "Get support",
          actionHint: "Open support path",
        },
      ],
      pastVisitSummaries: [
        {
          visitId: "past-1",
          completedDateTime: "2026-03-01T11:00:00-05:00",
          providerName: "Dr. Naomi Patel",
          specialty: "Cardiology",
          summaryTitle: "Follow-up summary",
          summarySnippet: "Blood pressure improved.",
        },
      ],
      reportsResults: [
        {
          resultId: "report-1",
          appointmentId: "apt-joinable",
          createdDateTime: "2026-03-14T10:00:00-05:00",
          providerName: "Dr. Naomi Patel",
          specialty: "Cardiology",
          topic: "Cholesterol",
          resultType: "Lab",
          status: "final",
          summaryTitle: "Cholesterol panel",
          summarySnippet: "LDL slightly elevated.",
        },
      ],
      notesAvs: [
        {
          noteId: "note-1",
          appointmentId: "apt-joinable",
          completedDateTime: "2026-03-01T11:30:00-05:00",
          providerName: "Dr. Naomi Patel",
          specialty: "Cardiology",
          topic: "Follow-up",
          summaryTitle: "After Visit Summary",
          summarySnippet: "Continue medication and hydration.",
        },
      ],
      messageThreads: [
        {
          threadId: "thread-1",
          appointmentId: "apt-joinable",
          updatedDateTime: "2026-03-15T09:00:00-05:00",
          providerName: "Dr. Naomi Patel",
          specialty: "Cardiology",
          topic: "Asthma follow-up",
          subject: "Medication question",
          preview: "Please confirm inhaler timing.",
          unreadCount: 1,
        },
      ],
      prescriptions: [
        {
          prescriptionId: "rx-1",
          appointmentId: "apt-joinable",
          createdDateTime: "2026-03-01T12:00:00-05:00",
          providerName: "Dr. Naomi Patel",
          specialty: "Cardiology",
          topic: "Blood pressure",
          medicationName: "Lisinopril",
          dosage: "10 mg daily",
          status: "active",
        },
      ],
      referrals: [
        {
          referralId: "ref-1",
          appointmentId: "apt-joinable",
          createdDateTime: "2026-03-01T12:15:00-05:00",
          providerName: "Dr. Naomi Patel",
          specialty: "Cardiology",
          topic: "Pulmonary support",
          referredTo: "Pulmonology Clinic",
          referralReason: "Follow-up breathing evaluation",
          status: "open",
        },
      ],
    },
  };

  const intent = parseNavigatorIntent(baseRequest.userGoal);

  const buildCandidate = (action: PlanActionResponse["action"]): PlanActionResponse => ({
    status: "ok",
    message: "Candidate action",
    action,
    confidence: 0.9,
    grounding: {
      matchedElementIds: action.targetId ? [action.targetId] : [],
      matchedVisibleText: [],
      reasoningSummary: "Model candidate for guardrail test.",
    },
  });

  const invalidTargetResult = enforcePlannerGuardrailsForTesting(
    buildCandidate({ type: "click", targetId: "missing-target-btn" }),
    baseRequest,
    intent,
  );
  assert.equal(invalidTargetResult.status, "need_clarification");
  assert.equal(invalidTargetResult.action.type, "ask_user");

  const hiddenTargetResult = enforcePlannerGuardrailsForTesting(
    buildCandidate({ type: "click", targetId: "hidden-join-btn" }),
    baseRequest,
    intent,
  );
  assert.equal(hiddenTargetResult.status, "need_clarification");
  assert.equal(hiddenTargetResult.action.type, "ask_user");

  const disabledTargetResult = enforcePlannerGuardrailsForTesting(
    buildCandidate({ type: "type", targetId: "disabled-name-input", value: "Jennifer Gold" }),
    baseRequest,
    intent,
  );
  assert.equal(disabledTargetResult.status, "need_clarification");
  assert.equal(disabledTargetResult.action.type, "ask_user");

  const ambiguityResult = enforcePlannerGuardrailsForTesting(
    buildCandidate({ type: "click", targetId: "message-thread-a-btn" }),
    baseRequest,
    intent,
  );
  assert.equal(ambiguityResult.status, "need_clarification");
  assert.equal(ambiguityResult.action.type, "ask_user");

  const destinationMismatchResult = enforcePlannerGuardrailsForTesting(
    buildCandidate({ type: "click", targetId: "referral-item-open-btn" }),
    baseRequest,
    intent,
  );
  assert.equal(destinationMismatchResult.status, "need_clarification");
  assert.equal(destinationMismatchResult.action.type, "ask_user");

  const prematureDoneResult = enforcePlannerGuardrailsForTesting(
    buildCandidate({ type: "done" }),
    baseRequest,
    intent,
  );
  assert.equal(prematureDoneResult.status, "need_clarification");
  assert.equal(prematureDoneResult.action.type, "ask_user");
}

async function main(): Promise<void> {
  runIntentParserRegression();
  console.log("[smoke] Generic intent parser regression checks passed");
  runPlannerGuardrailRegression();
  console.log("[smoke] Planner guardrail regression checks passed");

  const running = await startServer(0);
  const baseUrl = `http://127.0.0.1:${running.port}`;
  console.log(`[smoke] Server started on ${baseUrl}`);

  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.service, "silvervisit-backend");
    assert.equal(typeof health.liveApiConfigured, "boolean");
    assert.equal(typeof health.vertexConfigured, "boolean");
    assert.equal(typeof health.useVertexAI, "boolean");
    assert.equal(typeof health.liveEnabled, "boolean");
    assert.equal(typeof health.plannerModel, "string");
    assert.equal(typeof health.liveModel, "string");
    assert.equal(typeof health.googleCloudProjectConfigured, "boolean");
    assert.equal(typeof health.googleCloudLocation, "string");
    assert.equal(typeof health.httpRequestTimeoutMs, "number");
    assert.equal(typeof health.httpHeadersTimeoutMs, "number");
    assert.equal(typeof health.httpKeepAliveTimeoutMs, "number");
    assert.equal(typeof health.firestoreConfigured, "boolean");
    assert.equal(typeof health.firestoreMode, "string");
    assert.equal(typeof health.firestoreRuntimeReady, "boolean");
    console.log("[smoke] GET /health passed");

    let seededFixtureRecords: Array<{ seed: number; fixture: any }> = [];
    if (health.firestoreConfigured) {
      const fixtureSeed2Res = await fetch(`${baseUrl}/api/sandbox/fixture?seed=2`);
      assert.equal(fixtureSeed2Res.status, 200);
      const fixtureSeed2 = await fixtureSeed2Res.json();
      const fixtureSeed3Res = await fetch(`${baseUrl}/api/sandbox/fixture?seed=3`);
      assert.equal(fixtureSeed3Res.status, 200);
      const fixtureSeed3 = await fixtureSeed3Res.json();
      const fixtureSeed4Res = await fetch(`${baseUrl}/api/sandbox/fixture?seed=4`);
      assert.equal(fixtureSeed4Res.status, 200);
      const fixtureSeed4 = await fixtureSeed4Res.json();
      seededFixtureRecords = [fixtureSeed2, fixtureSeed3, fixtureSeed4];
      assert.notEqual(fixtureSeed2.fixture.patientName, fixtureSeed3.fixture.patientName);
      assert.notEqual(fixtureSeed3.fixture.patientName, fixtureSeed4.fixture.patientName);
      assert.notEqual(fixtureSeed2.fixture.appointmentType, fixtureSeed4.fixture.appointmentType);
      validateFixtureRealism(2, fixtureSeed2.fixture);
      validateFixtureRealism(3, fixtureSeed3.fixture);
      validateFixtureRealism(4, fixtureSeed4.fixture);
      console.log("[smoke] Deterministic seeded realism checks passed for seeds 2, 3, 4");

      const runStartRes = await fetch(`${baseUrl}/api/sandbox/run/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed: 3, source: "sandbox" }),
      });
      assert.equal(runStartRes.status, 200);
      const runStart = await runStartRes.json();
      assert.equal(typeof runStart.runId, "string");
      assert.equal(typeof runStart.fixture.patientName, "string");

      const runEventRes = await fetch(`${baseUrl}/api/sandbox/run/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: runStart.runId,
          step: "appointments",
          eventType: "step_transition",
          metadata: { from: "login", to: "appointments" },
        }),
      });
      assert.equal(runEventRes.status, 200);
      console.log("[smoke] Firestore-backed sandbox fixture/run routes passed");
    } else {
      console.log("[smoke] Firestore route checks skipped because firestoreConfigured=false");
    }

    const startRes = await fetch(`${baseUrl}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userGoal: "Join telehealth visit" }),
    });
    assert.equal(startRes.status, 200);
    const session = await startRes.json();
    assert.equal(typeof session.sessionId, "string");
    assert.equal(typeof session.createdAt, "string");
    console.log("[smoke] POST /api/session/start passed");

    const sessionGetRes = await fetch(`${baseUrl}/api/session/${session.sessionId}`);
    assert.equal(sessionGetRes.status, 200);
    const sessionGet = await sessionGetRes.json();
    assert.equal(sessionGet.sessionId, session.sessionId);
    console.log("[smoke] GET /api/session/:id passed");

    const fixturePath = path.resolve(__dirname, "..", "fixtures", "sample-plan-request.json");
    const screenshotPath = path.resolve(__dirname, "..", "fixtures", "sample-screenshot.png");
    const fixture = readFixtureJson(fixturePath);
    const screenshotB64 = fs.readFileSync(screenshotPath).toString("base64");

    fixture.sessionId = session.sessionId;
    fixture.screenshotBase64 = screenshotB64;

    const planRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fixture),
    });
    assert.equal(planRes.status, 200);
    const plan = await planRes.json();
    validatePlanActionShape(plan);
    console.log("[smoke] POST /api/plan-action passed with screenshot fixture");

    if (seededFixtureRecords.length > 0) {
      const conflictIdentityPayload = {
        ...fixture,
        userGoal: "I am Jennifer Gold and my date of birth is 05/11/1947. Help me join my appointment now.",
        sandboxFixture: seededFixtureRecords[0].fixture,
      };
      const conflictRes = await fetch(`${baseUrl}/api/plan-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(conflictIdentityPayload),
      });
      assert.equal(conflictRes.status, 200);
      const conflictPlan = await conflictRes.json();
      validatePlanActionShape(conflictPlan);
      assert.equal(conflictPlan.status, "need_clarification");
      assert.equal(conflictPlan.action.type, "ask_user");
      console.log("[smoke] User-provided identity conflict guardrail check passed");
    }

    if (seededFixtureRecords.length === 0) {
      seededFixtureRecords = [
        { seed: 2, fixture: fixture.sandboxFixture ?? {} },
        { seed: 3, fixture: fixture.sandboxFixture ?? {} },
        { seed: 4, fixture: fixture.sandboxFixture ?? {} },
      ];
    }
    const seededFixtures = buildSeededPlannerFixturesFromRecords(fixture, seededFixtureRecords);
    for (const seeded of seededFixtures) {
      const seededResponse = await fetch(`${baseUrl}/api/plan-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...seeded.payload,
          sessionId: session.sessionId,
        }),
      });
      assert.equal(seededResponse.status, 200);
      const seededPlan = await seededResponse.json();
      validatePlanActionShape(seededPlan);
      printVertexStatus(seededPlan, seeded.payload, `seed=${seeded.seed}`);
    }
    console.log("[smoke] Seeded planner regression checks completed for seeds 2, 3, 4");

    const invalidMimePayload = {
      ...fixture,
      screenshotMimeType: "image/gif",
    };
    const invalidMimeRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalidMimePayload),
    });
    assert.equal(invalidMimeRes.status, 400);
    const invalidMimeResponse = await invalidMimeRes.json();
    validatePlanActionShape(invalidMimeResponse);
    assert.equal(invalidMimeResponse.status, "error");
    console.log("[smoke] Validation guardrails passed");

    const emptyScreenshotPayload = {
      ...fixture,
      screenshotBase64: "",
    };
    const emptyScreenshotRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emptyScreenshotPayload),
    });
    assert.equal(emptyScreenshotRes.status, 400);
    const emptyScreenshotResponse = await emptyScreenshotRes.json();
    validatePlanActionShape(emptyScreenshotResponse);
    assert.equal(emptyScreenshotResponse.status, "error");

    const mismatchedMimePayload = {
      ...fixture,
      screenshotMimeType: "image/jpeg",
    };
    const mismatchedMimeRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mismatchedMimePayload),
    });
    assert.equal(mismatchedMimeRes.status, 400);
    const mismatchedMimeResponse = await mismatchedMimeRes.json();
    validatePlanActionShape(mismatchedMimeResponse);
    assert.equal(mismatchedMimeResponse.status, "error");

    const dataUrlPayload = {
      ...fixture,
      screenshotBase64: `data:${fixture.screenshotMimeType};base64,${screenshotB64}`,
    };
    const dataUrlRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dataUrlPayload),
    });
    assert.equal(dataUrlRes.status, 200);
    const dataUrlResponse = await dataUrlRes.json();
    validatePlanActionShape(dataUrlResponse);

    const unsupportedContentTypeRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(fixture),
    });
    assert.equal(unsupportedContentTypeRes.status, 415);
    const unsupportedContentTypePayload = await unsupportedContentTypeRes.json();
    validatePlanActionShape(unsupportedContentTypePayload);
    assert.equal(unsupportedContentTypePayload.status, "error");

    const malformedJsonRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"sessionId":"bad-json",',
    });
    assert.equal(malformedJsonRes.status, 400);
    const malformedJsonPayload = await malformedJsonRes.json();
    validatePlanActionShape(malformedJsonPayload);
    assert.equal(malformedJsonPayload.status, "error");

    const oversizedBody = JSON.stringify({ huge: "x".repeat(11 * 1024 * 1024) });
    const oversizedRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });
    assert.equal(oversizedRes.status, 413);
    const oversizedPayload = await oversizedRes.json();
    validatePlanActionShape(oversizedPayload);
    assert.equal(oversizedPayload.status, "error");
    console.log("[smoke] Parser/content-type/body-limit schema checks passed");

    const requireScreenshotPayload = {
      ...fixture,
      requireScreenshot: true,
      screenshotBase64: undefined,
      screenshotMimeType: undefined,
    };
    const requireScreenshotRes = await fetch(`${baseUrl}/api/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requireScreenshotPayload),
    });
    assert.equal(requireScreenshotRes.status, 400);
    const requireScreenshotError = await requireScreenshotRes.json();
    validatePlanActionShape(requireScreenshotError);
    assert.equal(requireScreenshotError.status, "error");
    assert.ok(
      String(requireScreenshotError.message).toLowerCase().includes("screenshot is required"),
      "requireScreenshot error should mention screenshot requirement",
    );
    console.log("[smoke] Screenshot-required contract checks passed");

    printVertexStatus(plan, fixture, "raw-base64 screenshot request");
    printVertexStatus(dataUrlResponse, fixture, "data-url-normalized screenshot request");

    const wsUrl = `ws://127.0.0.1:${running.port}/api/live`;
    const ws = new WebSocket(wsUrl);
    const wsMessages: any[] = [];

    ws.on("message", (raw) => {
      try {
        wsMessages.push(JSON.parse(raw.toString("utf8")));
      } catch {
        wsMessages.push({ type: "error", code: "non_json", message: raw.toString("utf8") });
      }
    });

    await waitForOpen(ws);

    let index = wsMessages.length;
    ws.send(JSON.stringify({ type: "user_text", text: "pre-start check" }));
    const preStartText = await waitForMessageMatching(
      wsMessages,
      index,
      4000,
      (message) => message.type === "error",
    );
    assert.equal(preStartText.type, "error");
    assert.equal(preStartText.code, "live_not_started");

    index = wsMessages.length;
    ws.send(
      JSON.stringify({
        type: "user_image_frame",
        mimeType: "image/png",
        dataBase64: screenshotB64,
      }),
    );
    const preStartImage = await waitForMessageMatching(
      wsMessages,
      index,
      4000,
      (message) => message.type === "error",
    );
    assert.equal(preStartImage.type, "error");
    assert.equal(preStartImage.code, "live_not_started");

    index = wsMessages.length;
    ws.send(
      JSON.stringify({
        type: "user_audio_chunk",
        mimeType: "audio/pcm;rate=16000",
        dataBase64: Buffer.from("demo-audio-bytes").toString("base64"),
      }),
    );
    const preStartAudio = await waitForMessageMatching(
      wsMessages,
      index,
      4000,
      (message) => message.type === "error",
    );
    assert.equal(preStartAudio.type, "error");
    assert.equal(preStartAudio.code, "live_not_started");

    index = wsMessages.length;
    ws.send(JSON.stringify({ type: "start", sessionId: session.sessionId, userGoal: "Live help" }));
    const startMessage = await waitForMessageMatching(
      wsMessages,
      index,
      4000,
      (message) =>
        message.type === "live_ready" || message.type === "transcript" || message.type === "error" || message.type === "model_text",
    );
    assert.ok(["live_ready", "transcript", "error", "model_text"].includes(startMessage.type));

    if (
      startMessage.type === "error" &&
      ["live_disabled", "live_not_configured", "live_start_failed"].includes(startMessage.code)
    ) {
      await waitForClose(ws);
      console.log("[smoke] WS /api/live route checks passed (fatal start path).");
      console.log("[smoke] All smoke checks passed.");
      return;
    }

    if (startMessage.type !== "live_ready") {
      const readyMessage = await waitForMessageMatching(
        wsMessages,
        index,
        7000,
        (message) => message.type === "live_ready" || message.type === "error",
      );
      if (readyMessage.type === "error") {
        assert.ok(["live_runtime_error", "live_start_failed"].includes(readyMessage.code));
      } else {
        assert.equal(readyMessage.type, "live_ready");
      }
    }

    index = wsMessages.length;
    ws.send(JSON.stringify({ type: "user_text", text: "Please help me join the visit." }));
    const userTextMessage = await waitForMessage(wsMessages, index, 4000);
    assert.ok(["transcript", "error", "model_text", "tool_call", "planned_action"].includes(userTextMessage.type));

    index = wsMessages.length;
    ws.send(
      JSON.stringify({
        type: "user_image_frame",
        mimeType: "image/png",
        dataBase64: screenshotB64,
      }),
    );
    const imageMessage = await waitForMessage(wsMessages, index, 4000);
    assert.ok(["transcript", "error", "model_text", "tool_call", "planned_action"].includes(imageMessage.type));

    index = wsMessages.length;
    ws.send(
      JSON.stringify({
        type: "user_audio_chunk",
        mimeType: "audio/pcm;rate=16000",
        dataBase64: Buffer.from("demo-audio-bytes").toString("base64"),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);

    index = wsMessages.length;
    ws.send(
      JSON.stringify({
        type: "user_audio_chunk",
        mimeType: "audio/webm",
        dataBase64: Buffer.from("bad-audio").toString("base64"),
      }),
    );
    const invalidAudioMessage = await waitForMessageMatching(
      wsMessages,
      index,
      4000,
      (message) => message.type === "error",
    );
    assert.equal(invalidAudioMessage.type, "error");
    assert.ok(["invalid_audio_mime_type", "live_not_ready", "live_runtime_error"].includes(invalidAudioMessage.code));

    ws.send(
      JSON.stringify({
        type: "user_audio_chunk",
        audioStreamEnd: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    ws.send(JSON.stringify({ type: "end" }));
    await waitForClose(ws);
    console.log("[smoke] WS /api/live route checks passed");

    console.log("[smoke] All smoke checks passed.");
  } finally {
    await running.close();
  }
}

main().catch((error) => {
  console.error(`[smoke] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
