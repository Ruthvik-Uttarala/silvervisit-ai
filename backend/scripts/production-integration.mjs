import assert from "node:assert/strict";

const baseUrl = (process.env.PROD_API_BASE || "").replace(/\/+$/, "");
assert.ok(baseUrl.startsWith("https://"), "PROD_API_BASE must be an https URL");

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lKsAAAAASUVORK5CYII=";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": crypto.randomUUID(),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed ${response.status}: ${text.slice(0, 600)}`);
  }
  return { status: response.status, body, headers: response.headers };
}

function assertGroundedPlan(plan, elementIds) {
  assert.ok(plan && typeof plan === "object", "plan response must be an object");
  assert.notEqual(plan.status, "error", `planner returned error: ${plan.message}`);
  assert.ok(["ok", "need_clarification"].includes(plan.status), `unexpected planner status ${plan.status}`);
  assert.ok(plan.action && typeof plan.action.type === "string", "planner action missing");
  assert.equal(typeof plan.confidence, "number", "planner confidence missing");
  assert.ok(plan.confidence >= 0 && plan.confidence <= 1, "planner confidence out of range");
  assert.ok(plan.grounding && Array.isArray(plan.grounding.matchedElementIds), "grounding missing");
  for (const id of plan.grounding.matchedElementIds) {
    assert.ok(elementIds.has(id), `planner grounded to unknown element ${id}`);
  }
  if (plan.action.targetId) {
    assert.ok(elementIds.has(plan.action.targetId), `planner selected unknown target ${plan.action.targetId}`);
  }
}

const health = await request("/health");
assert.equal(health.body.ok, true);
assert.equal(health.body.aiProvider, "gemini_api");
assert.equal(health.body.geminiConfigured, true);
assert.equal(health.body.databaseProvider, "supabase");
assert.equal(health.body.supabaseConfigured, true);
assert.equal(health.body.persistenceRuntimeReady, true);
console.log("PASS health", {
  aiProvider: health.body.aiProvider,
  geminiModel: health.body.geminiModel,
  databaseProvider: health.body.databaseProvider,
});

const fixtureResponse = await request("/api/sandbox/fixture?seed=2");
assert.equal(fixtureResponse.body.seed, 2);
assert.equal(fixtureResponse.body.fixture.seed, 2);
assert.ok(fixtureResponse.body.fixture.appointments.some((appointment) => appointment.joinableNow === true));
console.log("PASS fixture seed=2", {
  patient: fixtureResponse.body.fixture.patientName,
  appointments: fixtureResponse.body.fixture.appointments.length,
});

const fixture = fixtureResponse.body.fixture;
const runSummaries = [];

for (let iteration = 1; iteration <= 3; iteration += 1) {
  const goal = `Help me join my doctor appointment today. Integration run ${iteration}.`;
  const sessionResponse = await request("/api/session/start", {
    method: "POST",
    body: JSON.stringify({ userGoal: goal }),
  });
  const sessionId = sessionResponse.body.sessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/i, "invalid session ID");

  const persistedSession = await request(`/api/session/${sessionId}`);
  assert.equal(persistedSession.body.sessionId, sessionId);
  assert.equal(persistedSession.body.userGoal, goal);

  const runResponse = await request("/api/sandbox/run/start", {
    method: "POST",
    body: JSON.stringify({ seed: 2, source: "extension", navigatorSessionId: sessionId }),
  });
  const runId = runResponse.body.runId;
  assert.match(runId, /^[0-9a-f-]{36}$/i, "invalid run ID");
  assert.equal(runResponse.body.seed, 2);

  const eventResponse = await request("/api/sandbox/run/event", {
    method: "POST",
    body: JSON.stringify({
      runId,
      step: "integration_probe",
      eventType: "production_test",
      metadata: { iteration, synthetic: true },
    }),
  });
  assert.equal(eventResponse.body.ok, true);

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
  const planResponse = await request("/api/plan-action", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      userGoal: goal,
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
    }),
  });
  assertGroundedPlan(planResponse.body, new Set(elements.map((element) => element.id)));
  assert.notEqual(planResponse.body.action.targetId, "cancel-appointment-btn", "planner chose unsafe cancel action");

  runSummaries.push({
    iteration,
    sessionId,
    runId,
    status: planResponse.body.status,
    actionType: planResponse.body.action.type,
    targetId: planResponse.body.action.targetId || null,
    confidence: planResponse.body.confidence,
  });
  console.log(`PASS production integration run ${iteration}`, runSummaries.at(-1));
}

console.log("PRODUCTION_INTEGRATION_RESULT", JSON.stringify({ ok: true, runs: runSummaries }));
