import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
    assert.equal(planRes.status, 200);
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
        mimeType: "audio/pcm",
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
    assert.equal(preStartAudio.code, "unsupported_audio_chunk");

    index = wsMessages.length;
    ws.send(JSON.stringify({ type: "start", sessionId: session.sessionId, userGoal: "Live help" }));
    const startMessage = await waitForMessageMatching(
      wsMessages,
      index,
      4000,
      (message) => message.type === "transcript" || message.type === "error" || message.type === "model_text",
    );
    assert.ok(["transcript", "error", "model_text"].includes(startMessage.type));

    if (
      startMessage.type === "error" &&
      ["live_disabled", "live_not_configured", "live_start_failed"].includes(startMessage.code)
    ) {
      await waitForClose(ws);
      console.log("[smoke] WS /api/live route checks passed (fatal start path).");
      console.log("[smoke] All smoke checks passed.");
      return;
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
        mimeType: "audio/pcm",
        dataBase64: Buffer.from("demo-audio-bytes").toString("base64"),
      }),
    );
    const audioMessage = await waitForMessage(wsMessages, index, 4000);
    assert.equal(audioMessage.type, "error");
    assert.ok(
      ["unsupported_audio_chunk", "live_not_started", "live_not_ready", "live_runtime_error", "live_disabled"].includes(
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
