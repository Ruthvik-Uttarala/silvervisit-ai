import crypto from "node:crypto";
import { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { isVertexConfigured } from "./config";
import { Logger } from "./logger";
import { SessionStore } from "./sessions";
import { AppConfig, LiveClientMessage, LiveServerMessage, WsErrorMessage } from "./types";
import { decodeBase64, nowIso, safeErrorMessage, sanitizeBase64 } from "./utils";
import { getVertexClient } from "./vertex";
import { ALLOWED_IMAGE_MIME_TYPES } from "./validation/requestValidation";

interface LiveConnectionContext {
  config: AppConfig;
  logger: Logger;
  sessions: SessionStore;
  requestId: string;
}

function sendMessage(ws: WebSocket, message: LiveServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws: WebSocket, code: string, message: string, retryable = false): void {
  const payload: WsErrorMessage = {
    type: "error",
    code,
    message,
    retryable,
  };
  sendMessage(ws, payload);
}

function parseIncomingMessage(raw: WebSocket.RawData): LiveClientMessage | null {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as { type?: string };
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    return parsed as LiveClientMessage;
  } catch {
    return null;
  }
}

function collectTextSnippets(input: unknown, sink: string[]): void {
  if (!input || sink.length >= 4) {
    return;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed) {
      sink.push(trimmed);
    }
    return;
  }

  if (Array.isArray(input)) {
    for (const value of input) {
      collectTextSnippets(value, sink);
      if (sink.length >= 4) {
        break;
      }
    }
    return;
  }

  if (typeof input === "object") {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (key.toLowerCase().includes("text") || key.toLowerCase().includes("transcript")) {
        collectTextSnippets(value, sink);
      } else if (typeof value === "object") {
        collectTextSnippets(value, sink);
      }
      if (sink.length >= 4) {
        break;
      }
    }
  }
}

async function sendTextTurn(connection: any, text: string): Promise<void> {
  if (typeof connection?.sendClientContent === "function") {
    await connection.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [{ text }],
        },
      ],
      turnComplete: true,
    });
    return;
  }

  if (typeof connection?.sendRealtimeInput === "function") {
    await connection.sendRealtimeInput({ text });
    return;
  }

  throw new Error("Gemini Live session object does not support text input methods.");
}

async function sendImageTurn(connection: any, mimeType: string, dataBase64: string): Promise<void> {
  const data = sanitizeBase64(dataBase64);

  if (typeof connection?.sendClientContent === "function") {
    await connection.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType,
                data,
              },
            },
          ],
        },
      ],
      turnComplete: true,
    });
    return;
  }

  if (typeof connection?.sendRealtimeInput === "function") {
    await connection.sendRealtimeInput({
      media: {
        mimeType,
        data,
      },
    });
    return;
  }

  throw new Error("Gemini Live session object does not support image input methods.");
}

async function closeLiveConnection(connection: any): Promise<void> {
  if (!connection) {
    return;
  }

  if (typeof connection.close === "function") {
    await connection.close();
  }
}

export function handleLiveSocketConnection(
  ws: WebSocket,
  req: IncomingMessage,
  context: LiveConnectionContext,
): void {
  let liveSession: any = null;
  let liveStarted = false;
  let currentSessionId: string = crypto.randomUUID();

  sendMessage(ws, {
    type: "transcript",
    role: "system",
    text: "Live socket connected. Send a start message to initialize a session.",
  });

  const onModelMessage = (message: unknown): void => {
    const raw = message as any;

    if (raw?.toolCall && typeof raw.toolCall === "object") {
      sendMessage(ws, {
        type: "tool_call",
        name: typeof raw.toolCall.name === "string" ? raw.toolCall.name : "unknown_tool",
        args: (raw.toolCall.args ?? {}) as Record<string, unknown>,
      });
    }

    if (raw?.plannedAction && typeof raw.plannedAction === "object") {
      const actionRaw = raw.plannedAction as Record<string, unknown>;
      if (typeof actionRaw.type === "string") {
        sendMessage(ws, {
          type: "planned_action",
          action: {
            type: actionRaw.type as any,
          },
        });
      }
    }

    const snippets: string[] = [];
    collectTextSnippets(raw, snippets);
    for (const snippet of [...new Set(snippets)].slice(0, 2)) {
      sendMessage(ws, {
        type: "model_text",
        text: snippet,
      });
      sendMessage(ws, {
        type: "transcript",
        role: "model",
        text: snippet,
      });
    }
  };

  const handleStart = async (message: LiveClientMessage): Promise<void> => {
    const startMessage = message as Extract<LiveClientMessage, { type: "start" }>;
    if (startMessage.sessionId && typeof startMessage.sessionId === "string") {
      currentSessionId = startMessage.sessionId;
    }

    const goal = typeof startMessage.userGoal === "string" ? startMessage.userGoal.trim() : "Live support";
    context.sessions.upsertSession(currentSessionId, goal || "Live support");

    context.sessions.appendHistory(currentSessionId, {
      timestamp: nowIso(),
      type: "live_event",
      summary: "start",
    });

    sendMessage(ws, {
      type: "transcript",
      role: "system",
      text: `Live session initialized for ${currentSessionId}.`,
    });

    if (!context.config.enableLiveApi) {
      sendError(
        ws,
        "live_disabled",
        "Live API is disabled. Set ENABLE_LIVE_API=true to connect Gemini Live.",
        false,
      );
      return;
    }

    if (!isVertexConfigured(context.config)) {
      sendError(
        ws,
        "live_not_configured",
        "Vertex AI is not configured. Set GOOGLE_GENAI_USE_VERTEXAI=true, GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION.",
        false,
      );
      return;
    }

    try {
      const client: any = getVertexClient(context.config);
      liveSession = await client.live.connect({
        model: context.config.geminiLiveModel,
        callbacks: {
          onopen: () => {
            sendMessage(ws, {
              type: "transcript",
              role: "system",
              text: "Gemini Live session connected.",
            });
          },
          onmessage: (event: unknown) => {
            onModelMessage(event);
          },
          onerror: (error: unknown) => {
            sendError(ws, "live_runtime_error", safeErrorMessage(error), true);
          },
          onclose: () => {
            sendMessage(ws, {
              type: "transcript",
              role: "system",
              text: "Gemini Live session closed.",
            });
          },
        },
      });
      liveStarted = true;
    } catch (error) {
      sendError(
        ws,
        "live_start_failed",
        `Failed to start Gemini Live session: ${safeErrorMessage(error)}`,
        true,
      );
    }
  };

  const handleUserText = async (message: LiveClientMessage): Promise<void> => {
    const textMessage = message as Extract<LiveClientMessage, { type: "user_text" }>;
    if (typeof textMessage.text !== "string" || !textMessage.text.trim()) {
      sendError(ws, "invalid_user_text", "user_text message must include non-empty text.", false);
      return;
    }

    context.sessions.appendHistory(currentSessionId, {
      timestamp: nowIso(),
      type: "live_event",
      summary: "user_text",
    });

    sendMessage(ws, {
      type: "transcript",
      role: "user",
      text: textMessage.text.trim(),
    });

    if (!liveStarted || !liveSession) {
      sendError(ws, "live_not_started", "Send a start message before user_text.", true);
      return;
    }

    try {
      await sendTextTurn(liveSession, textMessage.text.trim());
    } catch (error) {
      sendError(ws, "live_send_text_failed", safeErrorMessage(error), true);
    }
  };

  const handleUserImageFrame = async (message: LiveClientMessage): Promise<void> => {
    const imageMessage = message as Extract<LiveClientMessage, { type: "user_image_frame" }>;
    if (typeof imageMessage.mimeType !== "string" || !ALLOWED_IMAGE_MIME_TYPES.has(imageMessage.mimeType)) {
      sendError(
        ws,
        "invalid_image_mime_type",
        `user_image_frame mimeType must be one of ${Array.from(ALLOWED_IMAGE_MIME_TYPES).join(", ")}.`,
        false,
      );
      return;
    }

    if (typeof imageMessage.dataBase64 !== "string") {
      sendError(ws, "invalid_image_payload", "user_image_frame must include dataBase64 string.", false);
      return;
    }

    try {
      decodeBase64(imageMessage.dataBase64);
    } catch (error) {
      sendError(ws, "invalid_image_payload", `Image data is not valid base64: ${safeErrorMessage(error)}`, false);
      return;
    }

    context.sessions.appendHistory(currentSessionId, {
      timestamp: nowIso(),
      type: "live_event",
      summary: "user_image_frame",
    });

    if (!liveStarted || !liveSession) {
      sendError(ws, "live_not_started", "Send a start message before user_image_frame.", true);
      return;
    }

    try {
      await sendImageTurn(liveSession, imageMessage.mimeType, imageMessage.dataBase64);
    } catch (error) {
      sendError(ws, "live_send_image_failed", safeErrorMessage(error), true);
    }
  };

  const handleUserAudioChunk = async (message: LiveClientMessage): Promise<void> => {
    const audioMessage = message as Extract<LiveClientMessage, { type: "user_audio_chunk" }>;
    if (typeof audioMessage.dataBase64 !== "string") {
      sendError(ws, "invalid_audio_payload", "user_audio_chunk must include dataBase64 string.", false);
      return;
    }

    try {
      decodeBase64(audioMessage.dataBase64);
    } catch (error) {
      sendError(ws, "invalid_audio_payload", `Audio data is not valid base64: ${safeErrorMessage(error)}`, false);
      return;
    }

    // TODO(raw-pcm): add explicit PCM framing + sample-rate contract for pass-through audio-in.
    sendError(
      ws,
      "unsupported_audio_chunk",
      "Raw audio chunk passthrough requires explicit PCM framing details. Use user_text or user_image_frame for demo flow.",
      false,
    );
  };

  const handleEnd = async (): Promise<void> => {
    context.sessions.appendHistory(currentSessionId, {
      timestamp: nowIso(),
      type: "live_event",
      summary: "end",
    });

    try {
      await closeLiveConnection(liveSession);
      liveSession = null;
      liveStarted = false;
    } catch (error) {
      sendError(ws, "live_close_failed", safeErrorMessage(error), false);
    }

    sendMessage(ws, {
      type: "transcript",
      role: "system",
      text: "Live session ended.",
    });
    ws.close(1000, "session ended");
  };

  ws.on("message", (raw) => {
    void (async () => {
      const message = parseIncomingMessage(raw);
      if (!message) {
        sendError(ws, "invalid_message", "Message must be valid JSON with a type field.", false);
        return;
      }

      try {
        switch (message.type) {
          case "start":
            await handleStart(message);
            return;
          case "user_text":
            await handleUserText(message);
            return;
          case "user_image_frame":
            await handleUserImageFrame(message);
            return;
          case "user_audio_chunk":
            await handleUserAudioChunk(message);
            return;
          case "end":
            await handleEnd();
            return;
          default:
            sendError(ws, "unsupported_message_type", `Unsupported message type ${(message as any).type}.`, false);
        }
      } catch (error) {
        context.logger.error("Unhandled live socket message error", {
          requestId: context.requestId,
          sessionId: currentSessionId,
          error: safeErrorMessage(error),
        });
        sendError(ws, "live_handler_error", safeErrorMessage(error), true);
      }
    })();
  });

  ws.on("close", () => {
    void closeLiveConnection(liveSession);
  });

  ws.on("error", (error) => {
    context.logger.warn("WebSocket transport error", {
      requestId: context.requestId,
      sessionId: currentSessionId,
      path: req.url,
      error: safeErrorMessage(error),
    });
  });
}
