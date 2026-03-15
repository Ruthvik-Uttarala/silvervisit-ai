import { ServerResponse } from "node:http";
import { FirestoreRepository } from "../firestore";
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
  firestore: FirestoreRepository,
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
  void firestore.upsertNavigatorSession(session.sessionId, session.userGoal).catch((error: unknown) => {
    log.warn("Failed to persist navigator session to Firestore", {
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
  firestore: FirestoreRepository,
): Promise<void> {
  const memoryRecord = sessions.get(sessionId);
  let firestoreRecord: Record<string, unknown> | null = null;
  try {
    firestoreRecord = await firestore.getNavigatorSession(sessionId);
  } catch {
    firestoreRecord = null;
  }
  if (!memoryRecord && !firestoreRecord) {
    sendJson(res, 404, { error: "Session not found." }, requestId);
    return;
  }
  sendJson(
    res,
    200,
    {
      sessionId,
      memoryRecord: memoryRecord ?? null,
      firestoreRecord,
    },
    requestId,
  );
}
