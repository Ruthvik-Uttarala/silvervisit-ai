import crypto from "node:crypto";
import { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { isVertexConfigured } from "./config";
import { FirestoreRepository } from "./firestore";
import { Logger } from "./logger";
import { SessionStore } from "./sessions";
import { AppConfig, LiveClientMessage, LiveServerMessage, WsErrorMessage } from "./types";
import { decodeBase64, nowIso, safeErrorMessage, safeString, sanitizeBase64 } from "./utils";
import { getVertexClient } from "./vertex";
import { ALLOWED_IMAGE_MIME_TYPES, detectImageMimeType } from "./validation/requestValidation";

interface LiveConnectionContext {
  config: AppConfig;
  logger: Logger;
  sessions: SessionStore;
  firestore: FirestoreRepository;
  requestId: string;
}

const LIVE_CONNECT_TIMEOUT_MS = 15000;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const AUDIO_MIME_PREFIX = "audio/pcm";

function optionalTurnId(turnId?: string): Record<string, string> {
  return typeof turnId === "string" && turnId.trim().length > 0 ? { turnId: turnId.trim() } : {};
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

function sendFatalErrorAndClose(ws: WebSocket, code: string, message: string): void {
  sendError(ws, code, message, false);
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, code);
    }
  }, 25);
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

async function sendAudioRealtimeInput(
  connection: any,
  payload: {
    mimeType?: string;
    dataBase64?: string;
    audioStreamEnd?: boolean;
  },
): Promise<void> {
  if (typeof connection?.sendRealtimeInput !== "function") {
    throw new Error("Gemini Live session object does not support realtime audio input.");
  }

  if (payload.audioStreamEnd && !payload.dataBase64) {
    await connection.sendRealtimeInput({
      audioStreamEnd: true,
    });
    return;
  }

  if (!payload.dataBase64 || !payload.mimeType) {
    throw new Error("Audio payload missing required mimeType or dataBase64.");
  }

  await connection.sendRealtimeInput({
    audio: {
      mimeType: payload.mimeType,
      data: sanitizeBase64(payload.dataBase64),
    },
    audioStreamEnd: payload.audioStreamEnd === true ? true : undefined,
  });
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
  let liveReady = false;
  let currentSessionId: string = crypto.randomUUID();
  const processedMessageIds = new Set<string>();

  const persistLiveEvent = (eventType: string, payload?: Record<string, unknown>) => {
    void context.firestore.recordLiveEvent(currentSessionId, eventType, payload).catch((error: unknown) => {
      context.logger.warn("Failed to persist live event to Firestore", {
        requestId: context.requestId,
        sessionId: currentSessionId,
        eventType,
        error: safeErrorMessage(error),
      });
    });
  };

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
      persistLiveEvent("model_text", {
        text: snippet.slice(0, 500),
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
      text: `Start request accepted for ${currentSessionId}. Initializing Gemini Live session.`,
    });
    persistLiveEvent("start_request", {
      sessionId: currentSessionId,
      userGoal: goal,
    });

    if (!context.config.enableLiveApi) {
      liveStarted = false;
      liveReady = false;
      sendFatalErrorAndClose(
        ws,
        "live_disabled",
        "Live API is disabled. Set ENABLE_LIVE_API=true to connect Gemini Live.",
      );
      return;
    }

    if (!isVertexConfigured(context.config)) {
      liveStarted = false;
      liveReady = false;
      sendFatalErrorAndClose(
        ws,
        "live_not_configured",
        "Vertex AI is not configured. Set GOOGLE_GENAI_USE_VERTEXAI=true, GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION.",
      );
      return;
    }

    try {
      if (liveSession) {
        await closeLiveConnection(liveSession);
        liveSession = null;
      }

      const client: any = getVertexClient(context.config);
      context.logger.info("Starting Gemini Live session", {
        requestId: context.requestId,
        sessionId: currentSessionId,
        provider: "@google/genai",
        vertexModeEnabled: context.config.useVertexAI,
        model: context.config.geminiLiveModel,
      });
      liveStarted = true;
      liveReady = false;
      const connectPromise = client.live.connect({
        model: context.config.geminiLiveModel,
        callbacks: {
          onopen: () => {
            liveReady = true;
            sendMessage(ws, {
              type: "live_ready",
              sessionId: currentSessionId,
              model: context.config.geminiLiveModel,
            });
            sendMessage(ws, {
              type: "transcript",
              role: "system",
              text: "LIVE_READY Gemini Live session connected and ready for text + image + audio turns.",
            });
            persistLiveEvent("live_ready", {
              model: context.config.geminiLiveModel,
            });
          },
          onmessage: (event: unknown) => {
            onModelMessage(event);
          },
          onerror: (error: unknown) => {
            liveReady = false;
            sendError(ws, "live_runtime_error", safeErrorMessage(error), true);
            persistLiveEvent("live_runtime_error", {
              error: safeErrorMessage(error),
            });
          },
          onclose: () => {
            liveStarted = false;
            liveReady = false;
            sendMessage(ws, {
              type: "transcript",
              role: "system",
              text: "Gemini Live session closed.",
            });
            persistLiveEvent("live_closed");
          },
        },
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Gemini Live connection timed out after ${LIVE_CONNECT_TIMEOUT_MS}ms`)), LIVE_CONNECT_TIMEOUT_MS);
      });
      liveSession = await Promise.race([connectPromise, timeoutPromise]);
    } catch (error) {
      liveStarted = false;
      liveReady = false;
      sendFatalErrorAndClose(
        ws,
        "live_start_failed",
        `Failed to start Gemini Live session: ${safeErrorMessage(error)}`,
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
    persistLiveEvent("user_text", {
      ...optionalTurnId(textMessage.turnId),
      text: textMessage.text,
    });

    if (!liveStarted || !liveSession) {
      sendError(ws, "live_not_started", "Send a start message before user_text.", true);
      return;
    }

    if (!liveReady) {
      sendError(ws, "live_not_ready", "Wait for LIVE_READY acknowledgement before sending user_text.", true);
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
      const decoded = decodeBase64(imageMessage.dataBase64);
      const detectedMime = detectImageMimeType(decoded);
      if (!detectedMime) {
        sendError(ws, "invalid_image_payload", "Image payload is not a valid PNG, JPEG, or WEBP byte stream.", false);
        return;
      }
      if (detectedMime !== imageMessage.mimeType) {
        sendError(
          ws,
          "invalid_image_payload",
          `Image payload mime mismatch. Declared ${imageMessage.mimeType}, detected ${detectedMime}.`,
          false,
        );
        return;
      }
    } catch (error) {
      sendError(ws, "invalid_image_payload", `Image data is not valid base64: ${safeErrorMessage(error)}`, false);
      return;
    }

    context.sessions.appendHistory(currentSessionId, {
      timestamp: nowIso(),
      type: "live_event",
      summary: "user_image_frame",
    });
    persistLiveEvent("user_image_frame", {
      ...optionalTurnId(imageMessage.turnId),
      mimeType: imageMessage.mimeType,
    });

    if (!liveStarted || !liveSession) {
      sendError(ws, "live_not_started", "Send a start message before user_image_frame.", true);
      return;
    }

    if (!liveReady) {
      sendError(ws, "live_not_ready", "Wait for LIVE_READY acknowledgement before sending user_image_frame.", true);
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
    if (!liveStarted || !liveSession) {
      sendError(ws, "live_not_started", "Send a start message before user_audio_chunk.", true);
      return;
    }

    if (!liveReady) {
      sendError(ws, "live_not_ready", "Wait for LIVE_READY acknowledgement before sending user_audio_chunk.", true);
      return;
    }

    if (audioMessage.audioStreamEnd === true && !audioMessage.dataBase64) {
      try {
        await sendAudioRealtimeInput(liveSession, {
          audioStreamEnd: true,
        });
        context.sessions.appendHistory(currentSessionId, {
          timestamp: nowIso(),
          type: "live_event",
          summary: "user_audio_stream_end",
        });
        persistLiveEvent("user_audio_stream_end", {
          ...optionalTurnId(audioMessage.turnId),
        });
      } catch (error) {
        sendError(ws, "live_send_audio_failed", safeErrorMessage(error), true);
      }
      return;
    }

    if (typeof audioMessage.dataBase64 !== "string") {
      sendError(ws, "invalid_audio_payload", "user_audio_chunk must include dataBase64 string.", false);
      return;
    }

    const mimeTypeRaw = typeof audioMessage.mimeType === "string" ? audioMessage.mimeType.trim().toLowerCase() : "";
    if (!mimeTypeRaw || !mimeTypeRaw.startsWith(AUDIO_MIME_PREFIX)) {
      sendError(
        ws,
        "invalid_audio_mime_type",
        "user_audio_chunk mimeType must start with audio/pcm (for example audio/pcm;rate=16000).",
        false,
      );
      return;
    }

    let decoded: Buffer;
    try {
      decoded = decodeBase64(audioMessage.dataBase64);
    } catch (error) {
      sendError(ws, "invalid_audio_payload", `Audio data is not valid base64: ${safeErrorMessage(error)}`, false);
      return;
    }
    if (decoded.byteLength > MAX_AUDIO_CHUNK_BYTES) {
      sendError(
        ws,
        "invalid_audio_payload",
        `Audio chunk exceeds max size of ${MAX_AUDIO_CHUNK_BYTES} bytes.`,
        false,
      );
      return;
    }

    context.sessions.appendHistory(currentSessionId, {
      timestamp: nowIso(),
      type: "live_event",
      summary: "user_audio_chunk",
    });
    persistLiveEvent("user_audio_chunk", {
      ...optionalTurnId(audioMessage.turnId),
      mimeType: mimeTypeRaw,
      bytes: decoded.byteLength,
    });

    try {
      await sendAudioRealtimeInput(liveSession, {
        mimeType: mimeTypeRaw,
        dataBase64: audioMessage.dataBase64,
        audioStreamEnd: audioMessage.audioStreamEnd === true ? true : undefined,
      });
    } catch (error) {
      sendError(ws, "live_send_audio_failed", safeErrorMessage(error), true);
    }
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
      liveReady = false;
    } catch (error) {
      sendError(ws, "live_close_failed", safeErrorMessage(error), false);
    }

    sendMessage(ws, {
      type: "transcript",
      role: "system",
      text: "Live session ended.",
    });
    persistLiveEvent("end");
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
        const messageId = safeString((message as any).messageId);
        if (messageId) {
          if (processedMessageIds.has(messageId)) {
            sendMessage(ws, {
              type: "transcript",
              role: "system",
              text: `Duplicate live message ignored: ${messageId}`,
            });
            persistLiveEvent("duplicate_message_ignored", { messageId, type: message.type });
            return;
          }
          processedMessageIds.add(messageId);
          if (processedMessageIds.size > 500) {
            const [first] = processedMessageIds;
            if (first) {
              processedMessageIds.delete(first);
            }
          }
        }
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
    liveReady = false;
    liveStarted = false;
    void closeLiveConnection(liveSession);
    liveSession = null;
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
