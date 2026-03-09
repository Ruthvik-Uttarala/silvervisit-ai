import crypto from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { ActionObject, PlanActionResponse } from "./types";

const REDACT_KEYS = new Set(["screenshotBase64", "framesBase64", "dataBase64", "authorization", "cookie"]);

export function generateRequestId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown, requestId?: string): void {
  if (!res.headersSent) {
    setCorsHeaders(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (requestId) {
      res.setHeader("X-Request-Id", requestId);
    }
  }
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeds maximum size of ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export function sanitizeBase64(input: string): string {
  const trimmed = input.trim();
  const commaIndex = trimmed.indexOf(",");
  if (trimmed.startsWith("data:") && commaIndex > 0) {
    return trimmed.slice(commaIndex + 1).replace(/\s+/g, "");
  }
  return trimmed.replace(/\s+/g, "");
}

export function decodeBase64(input: string): Buffer {
  const sanitized = sanitizeBase64(input);
  if (!sanitized) {
    throw new Error("Base64 payload is empty");
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(sanitized)) {
    throw new Error("Base64 payload contains invalid characters");
  }
  const buffer = Buffer.from(sanitized, "base64");
  if (buffer.length === 0) {
    throw new Error("Base64 payload decoded to empty content");
  }
  return buffer;
}

export function safeString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

export function clampConfidence(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  if (num < 0) {
    return 0;
  }
  if (num > 1) {
    return 1;
  }
  return num;
}

export function toSafeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function redactForLog(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) {
      return input;
    }

    if (typeof input === "string") {
      return input.length > 600 ? `${input.slice(0, 600)}...[truncated]` : input;
    }

    if (typeof input !== "object") {
      return input;
    }

    if (seen.has(input as object)) {
      return "[circular]";
    }
    seen.add(input as object);

    if (Array.isArray(input)) {
      return input.map((item) => walk(item));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) {
      if (REDACT_KEYS.has(key)) {
        if (typeof val === "string") {
          out[key] = `[redacted string len=${val.length}]`;
        } else if (Array.isArray(val)) {
          out[key] = `[redacted array len=${val.length}]`;
        } else {
          out[key] = "[redacted]";
        }
      } else {
        out[key] = walk(val);
      }
    }
    return out;
  };

  return walk(value);
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
}

export function getActionFallback(
  status: PlanActionResponse["status"],
  message: string,
  reasoningSummary: string,
): PlanActionResponse {
  const action: ActionObject = { type: "ask_user" };
  return {
    status,
    message,
    action,
    confidence: status === "error" ? 0 : 0.2,
    grounding: {
      matchedElementIds: [],
      matchedVisibleText: [],
      reasoningSummary,
    },
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
