import { ServerResponse } from "node:http";
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
