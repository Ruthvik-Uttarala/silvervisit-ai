import { ACTION_PLANNER_SYSTEM_PROMPT } from "./prompts/actionPlannerSystemPrompt";
import {
  ACTION_AMOUNTS,
  ACTION_DIRECTIONS,
  ACTION_TYPES,
  ActionObject,
  AppConfig,
  PlanActionRequest,
  PlanActionResponse,
  SessionEvent,
  UIElement,
} from "./types";
import { Logger } from "./logger";
import { getVertexClient } from "./vertex";
import { clampConfidence, getActionFallback, sanitizeBase64, safeErrorMessage, safeString } from "./utils";

const ACTION_TYPES_SET = new Set<string>(ACTION_TYPES);
const DIRECTION_SET = new Set<string>(ACTION_DIRECTIONS);
const AMOUNT_SET = new Set<string>(ACTION_AMOUNTS);
const REQUIRED_TARGET_TYPES = new Set(["click", "type", "highlight"]);

const ACTION_RESPONSE_SCHEMA = {
  type: "object",
  required: ["status", "message", "action", "confidence", "grounding"],
  properties: {
    status: {
      type: "string",
      enum: ["ok", "need_clarification", "error"],
    },
    message: { type: "string" },
    action: {
      type: "object",
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: ["highlight", "click", "type", "scroll", "wait", "ask_user", "done"],
        },
        targetId: { type: "string" },
        value: { type: "string" },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
        },
        amount: {
          type: "string",
          enum: ["small", "medium", "large"],
        },
        delayMs: { type: "number" },
      },
      additionalProperties: false,
    },
    confidence: { type: "number" },
    grounding: {
      type: "object",
      required: ["matchedElementIds", "matchedVisibleText", "reasoningSummary"],
      properties: {
        matchedElementIds: {
          type: "array",
          items: { type: "string" },
        },
        matchedVisibleText: {
          type: "array",
          items: { type: "string" },
        },
        reasoningSummary: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

interface PlannerContext {
  config: AppConfig;
  logger: Logger;
  requestId: string;
  recentHistory: SessionEvent[];
}

function buildAskUser(
  message: string,
  reasoningSummary: string,
  status: PlanActionResponse["status"] = "need_clarification",
): PlanActionResponse {
  return getActionFallback(status, message, reasoningSummary);
}

function summarizeElements(elements: UIElement[]): Array<Record<string, unknown>> {
  return elements.map((element) => ({
    id: element.id,
    text: element.text,
    role: element.role,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    placeholder: element.placeholder,
    value: element.value,
    enabled: element.enabled,
    visible: element.visible,
  }));
}

function extractJsonCandidate(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(slice) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractModelText(response: any): string {
  if (!response) {
    return "";
  }

  if (typeof response.text === "function") {
    const maybeText = response.text();
    return typeof maybeText === "string" ? maybeText : "";
  }

  if (typeof response.text === "string") {
    return response.text;
  }

  if (response.response) {
    return extractModelText(response.response);
  }

  const candidateText = response.candidates?.[0]?.content?.parts
    ?.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");

  if (typeof candidateText === "string") {
    return candidateText;
  }

  return "";
}

function normalizeAction(raw: Record<string, unknown>): ActionObject {
  const actionRaw = (raw.action ?? {}) as Record<string, unknown>;
  const typeRaw = safeString(actionRaw.type);
  const type = ACTION_TYPES_SET.has(typeRaw) ? (typeRaw as ActionObject["type"]) : "ask_user";

  const action: ActionObject = { type };

  const targetId = safeString(actionRaw.targetId);
  if (targetId) {
    action.targetId = targetId;
  }

  const value = typeof actionRaw.value === "string" ? actionRaw.value.slice(0, 500) : "";
  if (value) {
    action.value = value;
  }

  const direction = safeString(actionRaw.direction);
  if (DIRECTION_SET.has(direction)) {
    action.direction = direction as ActionObject["direction"];
  }

  const amount = safeString(actionRaw.amount);
  if (AMOUNT_SET.has(amount)) {
    action.amount = amount as ActionObject["amount"];
  }

  const delayMs = Number(actionRaw.delayMs);
  if (Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 120000) {
    action.delayMs = Math.round(delayMs);
  }

  return action;
}

function normalizeGrounding(raw: Record<string, unknown>, request: PlanActionRequest): PlanActionResponse["grounding"] {
  const groundingRaw = (raw.grounding ?? {}) as Record<string, unknown>;
  const elementSet = new Set(request.elements.map((element) => element.id));
  const visibleTextSet = new Set(request.visibleText);

  const rawElementIds = Array.isArray(groundingRaw.matchedElementIds) ? groundingRaw.matchedElementIds : [];
  const matchedElementIds = rawElementIds
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && elementSet.has(value));

  const rawVisibleText = Array.isArray(groundingRaw.matchedVisibleText) ? groundingRaw.matchedVisibleText : [];
  const matchedVisibleText = rawVisibleText
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && visibleTextSet.has(value));

  const reasoningSummaryRaw = safeString(groundingRaw.reasoningSummary);
  const reasoningSummary = reasoningSummaryRaw
    ? reasoningSummaryRaw.slice(0, 240)
    : "The next step was selected from the visible page evidence.";

  return {
    matchedElementIds: [...new Set(matchedElementIds)],
    matchedVisibleText: [...new Set(matchedVisibleText)],
    reasoningSummary,
  };
}

function isInteractableElement(element: UIElement | undefined): boolean {
  if (!element) {
    return false;
  }
  if (element.visible === false) {
    return false;
  }
  if (element.enabled === false) {
    return false;
  }
  return true;
}

function enforceGuardrails(candidate: PlanActionResponse, request: PlanActionRequest): PlanActionResponse {
  const elementMap = new Map(request.elements.map((element) => [element.id, element]));

  const response: PlanActionResponse = {
    status: candidate.status,
    message: candidate.message.slice(0, 280),
    action: { ...candidate.action },
    confidence: clampConfidence(candidate.confidence),
    grounding: {
      matchedElementIds: [...candidate.grounding.matchedElementIds],
      matchedVisibleText: [...candidate.grounding.matchedVisibleText],
      reasoningSummary: candidate.grounding.reasoningSummary.slice(0, 240),
    },
  };

  if (!ACTION_TYPES_SET.has(response.action.type)) {
    return buildAskUser(
      "I need clarification before taking an action.",
      "The predicted action type was not valid for this UI step.",
    );
  }

  if (REQUIRED_TARGET_TYPES.has(response.action.type) && !response.action.targetId) {
    return buildAskUser(
      "I need clarification on which control to use next.",
      "The requested action needs a specific visible target.",
    );
  }

  if (response.action.targetId) {
    const target = elementMap.get(response.action.targetId);
    if (!target) {
      return buildAskUser(
        "I need clarification before selecting a control.",
        "The suggested target was not present in the provided element list.",
      );
    }

    if (!isInteractableElement(target) && !request.allowNonInteractableGuidance) {
      return buildAskUser(
        "That control appears unavailable right now. Please confirm the next step.",
        "The target element is hidden or disabled in the provided UI state.",
      );
    }

    if (!response.grounding.matchedElementIds.includes(response.action.targetId)) {
      response.grounding.matchedElementIds.push(response.action.targetId);
    }
  }

  if (response.action.type === "type" && !response.action.value) {
    return buildAskUser(
      "I need the text to enter before continuing.",
      "The typing action did not include a grounded input value.",
    );
  }

  const hasGrounding =
    response.grounding.matchedElementIds.length > 0 || response.grounding.matchedVisibleText.length > 0;

  if (response.status === "ok" && response.action.type !== "ask_user" && !hasGrounding) {
    return buildAskUser(
      "I need clarification before taking action.",
      "No grounded element IDs or visible text evidence was returned.",
    );
  }

  if (response.action.type === "ask_user" && response.status === "ok") {
    response.status = "need_clarification";
    response.confidence = Math.min(response.confidence, 0.3);
  }

  if (response.status === "error") {
    response.action = { type: "ask_user" };
    response.confidence = 0;
    response.grounding.matchedElementIds = [];
    response.grounding.matchedVisibleText = [];
  }

  return response;
}

function normalizeModelOutput(rawObject: Record<string, unknown>, request: PlanActionRequest): PlanActionResponse {
  const statusRaw = safeString(rawObject.status);
  const status: PlanActionResponse["status"] =
    statusRaw === "ok" || statusRaw === "need_clarification" || statusRaw === "error"
      ? statusRaw
      : "need_clarification";

  const messageRaw = safeString(rawObject.message);
  const message = messageRaw || "I reviewed the current screen and selected the safest next step.";

  const action = normalizeAction(rawObject);
  const grounding = normalizeGrounding(rawObject, request);

  const normalized: PlanActionResponse = {
    status,
    message: message.slice(0, 280),
    action,
    confidence: clampConfidence(rawObject.confidence),
    grounding,
  };

  return enforceGuardrails(normalized, request);
}

function buildUserPayload(request: PlanActionRequest, recentHistory: SessionEvent[]): string {
  const payload = {
    task: "Pick exactly one best next UI action for a telehealth flow.",
    constraints: {
      groundedOnly: true,
      noInventedIds: true,
      askUserIfAmbiguous: true,
      respectHiddenDisabled: true,
    },
    context: {
      sessionId: request.sessionId,
      userGoal: request.userGoal,
      pageUrl: request.pageUrl,
      pageTitle: request.pageTitle,
      sandboxFixture: request.sandboxFixture,
      visibleText: request.visibleText,
      elements: summarizeElements(request.elements),
      recentHistory,
    },
  };

  return JSON.stringify(payload);
}

export async function planNextAction(request: PlanActionRequest, context: PlannerContext): Promise<PlanActionResponse> {
  let client: any;
  try {
    client = getVertexClient(context.config) as any;
  } catch (error) {
    return buildAskUser(
      "Vertex AI is not configured for action planning.",
      safeErrorMessage(error),
      "error",
    );
  }

  const userParts: any[] = [
    {
      text: buildUserPayload(request, context.recentHistory),
    },
  ];

  if (request.screenshotBase64 && request.screenshotMimeType) {
    userParts.push({
      inlineData: {
        mimeType: request.screenshotMimeType,
        data: sanitizeBase64(request.screenshotBase64),
      },
    });
  }

  if (Array.isArray(request.framesBase64) && request.framesBase64.length > 0) {
    const mimeType = request.screenshotMimeType ?? "image/png";
    for (const frame of request.framesBase64.slice(0, 3)) {
      userParts.push({
        inlineData: {
          mimeType,
          data: sanitizeBase64(frame),
        },
      });
    }
  }

  try {
    context.logger.info("Invoking Gemini planner on Vertex AI", {
      requestId: context.requestId,
      sessionId: request.sessionId,
      provider: "@google/genai",
      vertexModeEnabled: context.config.useVertexAI,
      model: context.config.geminiActionModel,
    });

    const response: any = await client.models.generateContent({
      model: context.config.geminiActionModel,
      contents: [
        {
          role: "user",
          parts: userParts,
        },
      ],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: ACTION_RESPONSE_SCHEMA,
        systemInstruction: ACTION_PLANNER_SYSTEM_PROMPT,
      },
    });

    const text = extractModelText(response);
    const parsed = extractJsonCandidate(text);
    if (!parsed) {
      context.logger.warn("Model returned unparseable response", {
        requestId: context.requestId,
        sessionId: request.sessionId,
        modelText: text,
      });
      return buildAskUser(
        "I could not confidently determine the next step from this screen.",
        "The model response could not be parsed into the required action format.",
      );
    }

    return normalizeModelOutput(parsed, request);
  } catch (error) {
    const errorMessage = safeErrorMessage(error);
    context.logger.error("Vertex action planning failed", {
      requestId: context.requestId,
      sessionId: request.sessionId,
      error: errorMessage,
    });

    return buildAskUser(
      "I could not reach Gemini on Vertex AI for this step.",
      errorMessage,
      "error",
    );
  }
}
