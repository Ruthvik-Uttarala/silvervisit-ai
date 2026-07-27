import { ServerResponse } from "node:http";
import { AppRepository } from "../repository";
import { SessionStore } from "../sessions";
import { Logger } from "../logger";
import { sendJson } from "../utils";
import { validateSessionStartRequest } from "../validation/requestValidation";

export function handleSessionStart(
  res: ServerResponse,
  body: unknown,
  requestId: string,
  sessions: SessionStore,
  log: Logger,
  repository: AppRepository,
): void {
  const validation = validateSessionStartRequest(body);
  if (!validation.ok) {
    sendJson(
      res,
      validation.statusCode,
      {
        error: validation.message,
      },
      requestId,
    );
    return;
  }

  const session = sessions.createSession(validation.value.userGoal);
  log.info("Session started", {
    requestId,
    sessionId: session.sessionId,
  });
  void repository.upsertNavigatorSession(session.sessionId, session.userGoal).catch((error: unknown) => {
    log.warn("Failed to persist navigator session", {
      requestId,
      sessionId: session.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  sendJson(
    res,
    200,
    {
      sessionId: session.sessionId,
      createdAt: session.createdAt,
    },
    requestId,
  );
}

export async function handleSessionGet(
  res: ServerResponse,
  requestId: string,
  sessionId: string,
  sessions: SessionStore,
  repository: AppRepository,
): Promise<void> {
  const memoryRecord = sessions.get(sessionId);
  let persistedRecord: Record<string, unknown> | null = null;
  try {
    persistedRecord = await repository.getNavigatorSession(sessionId);
  } catch {
    persistedRecord = null;
  }
  if (!memoryRecord && !persistedRecord) {
    sendJson(res, 404, { error: "Session not found." }, requestId);
    return;
  }
  sendJson(
    res,
    200,
    {
      sessionId,
      memoryRecord: memoryRecord ?? null,
      persistedRecord,
    },
    requestId,
  );
}
