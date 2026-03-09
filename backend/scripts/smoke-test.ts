import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { startServer } from "../src/server";

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

function printVertexStatus(planActionResponse: any): void {
  const missing: string[] = [];
  if ((process.env.GOOGLE_GENAI_USE_VERTEXAI ?? "").toLowerCase() !== "true") {
    missing.push("GOOGLE_GENAI_USE_VERTEXAI=true");
  }
  if (!process.env.GOOGLE_CLOUD_PROJECT) {
    missing.push("GOOGLE_CLOUD_PROJECT");
  }
  if (!process.env.GOOGLE_CLOUD_LOCATION) {
    missing.push("GOOGLE_CLOUD_LOCATION");
  }

  if (missing.length > 0) {
    console.log(
      `[smoke] Vertex real-call skipped because env is missing: ${missing.join(", ")}. ` +
        "Set these and ensure ADC is available (gcloud auth application-default login).",
    );
    return;
  }

  if (
    planActionResponse.status === "error" &&
    /credential|auth|permission|vertex|adc|could not reach/i.test(planActionResponse.message)
  ) {
    console.log(
      "[smoke] Vertex env vars are set, but the real Gemini planning call failed. " +
        "Likely missing or invalid Application Default Credentials. " +
        "Run: gcloud auth application-default login (or use Cloud Run service account).",
    );
    return;
  }

  console.log("[smoke] Real Vertex Gemini planning call appears successful.");
  console.log(`[smoke] Validated model response: ${JSON.stringify(planActionResponse)}`);
}

async function main(): Promise<void> {
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
    console.log("[smoke] GET /health passed");

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
    assert.ok([200, 500].includes(planRes.status));
    const plan = await planRes.json();
    validatePlanActionShape(plan);
    console.log("[smoke] POST /api/plan-action passed with screenshot fixture");

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

    printVertexStatus(plan);

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
    ws.send(JSON.stringify({ type: "start", sessionId: session.sessionId, userGoal: "Live help" }));
    const startMessage = await waitForMessage(wsMessages, index, 4000);
    assert.ok(["transcript", "error", "model_text"].includes(startMessage.type));

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
        mimeType: "audio/pcm",
        dataBase64: Buffer.from("demo-audio-bytes").toString("base64"),
      }),
    );
    const audioMessage = await waitForMessage(wsMessages, index, 4000);
    assert.equal(audioMessage.type, "error");
    assert.ok(
      ["unsupported_audio_chunk", "live_not_started", "live_runtime_error", "live_disabled"].includes(
        audioMessage.code,
      ),
    );

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
