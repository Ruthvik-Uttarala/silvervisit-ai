import { ServerResponse } from "node:http";
import { FirestoreRepository } from "../firestore";
import { Logger } from "../logger";
import { SandboxRunEventRequest, SandboxRunStartRequest } from "../types";
import { isObject, safeString, sendJson } from "../utils";

function parseSeed(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  const normalized = Math.floor(Math.abs(numeric));
  if (normalized <= 0) {
    return undefined;
  }
  return normalized;
}

function parseRunStartRequest(body: unknown): SandboxRunStartRequest {
  if (!isObject(body)) {
    return {};
  }
  const sourceRaw = safeString(body.source);
  const source = sourceRaw === "extension" || sourceRaw === "sandbox" ? sourceRaw : undefined;
  const navigatorSessionIdRaw = safeString(body.navigatorSessionId);
  return {
    seed: parseSeed(body.seed),
    source,
    navigatorSessionId: navigatorSessionIdRaw || undefined,
  };
}

function parseRunEventRequest(body: unknown): SandboxRunEventRequest | null {
  if (!isObject(body)) {
    return null;
  }
  const runId = safeString(body.runId);
  const step = safeString(body.step);
  const eventType = safeString(body.eventType);
  if (!runId || !step || !eventType) {
    return null;
  }
  const metadata = isObject(body.metadata) ? body.metadata : undefined;
  return {
    runId,
    step,
    eventType,
    metadata,
  };
}

export async function handleSandboxFixture(
  res: ServerResponse,
  requestId: string,
  repository: FirestoreRepository,
  seedInput?: number,
): Promise<void> {
  const resolved = await repository.getFixtureBySeed(seedInput);
  sendJson(
    res,
    200,
    {
      seed: resolved.seed,
      fixture: resolved.fixture,
    },
    requestId,
  );
}

export async function handleSandboxRunStart(
  res: ServerResponse,
  body: unknown,
  requestId: string,
  repository: FirestoreRepository,
  logger: Logger,
): Promise<void> {
  const request = parseRunStartRequest(body);
  const response = await repository.startSandboxRun(request);
  logger.info("Sandbox run started", {
    requestId,
    runId: response.runId,
    seed: response.seed,
    source: request.source ?? "sandbox",
  });
  sendJson(res, 200, response, requestId);
}

export async function handleSandboxRunEvent(
  res: ServerResponse,
  body: unknown,
  requestId: string,
  repository: FirestoreRepository,
): Promise<void> {
  const request = parseRunEventRequest(body);
  if (!request) {
    sendJson(
      res,
      400,
      {
        error: "runId, step, and eventType are required for /api/sandbox/run/event.",
      },
      requestId,
    );
    return;
  }
  await repository.appendSandboxRunEvent(request);
  sendJson(res, 200, { ok: true }, requestId);
}
