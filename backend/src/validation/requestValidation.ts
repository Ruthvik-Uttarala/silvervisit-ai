import { PlanActionRequest, SessionStartRequest, UIElement, ValidationResult } from "../types";
import { decodeBase64, isObject, safeString, toSafeObject } from "../utils";

export const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_SCREENSHOT_BYTES = 7 * 1024 * 1024;
export const MAX_VISIBLE_TEXT_ITEMS = 400;
export const MAX_VISIBLE_TEXT_ITEM_LENGTH = 400;
export const MAX_ELEMENTS = 500;
export const MAX_TEXT_FIELD_LENGTH = 1000;
export const MAX_ELEMENT_TEXT_LENGTH = 500;
export const MAX_FRAMES = 5;

function validationError(statusCode: number, message: string): ValidationResult<never> {
  return { ok: false, statusCode, message };
}

function validateStringField(value: unknown, fieldName: string, maxLength: number): string | null {
  if (typeof value !== "string") {
    return `${fieldName} must be a string`;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return `${fieldName} is required`;
  }
  if (trimmed.length > maxLength) {
    return `${fieldName} exceeds max length ${maxLength}`;
  }
  return null;
}

function validateElement(raw: unknown, index: number): string | null {
  if (!isObject(raw)) {
    return `elements[${index}] must be an object`;
  }

  const idError = validateStringField(raw.id, `elements[${index}].id`, 120);
  if (idError) {
    return idError;
  }

  const textError = validateStringField(raw.text, `elements[${index}].text`, MAX_ELEMENT_TEXT_LENGTH);
  if (textError) {
    return textError;
  }

  const roleError = validateStringField(raw.role, `elements[${index}].role`, 120);
  if (roleError) {
    return roleError;
  }

  for (const numericField of ["x", "y", "width", "height"] as const) {
    if (typeof raw[numericField] !== "number" || !Number.isFinite(raw[numericField])) {
      return `elements[${index}].${numericField} must be a finite number`;
    }
  }

  if ((raw.width as number) < 0 || (raw.height as number) < 0) {
    return `elements[${index}] width/height must be >= 0`;
  }

  for (const optionalTextField of ["placeholder", "value"] as const) {
    if (
      raw[optionalTextField] !== undefined &&
      (typeof raw[optionalTextField] !== "string" ||
        (raw[optionalTextField] as string).length > MAX_TEXT_FIELD_LENGTH)
    ) {
      return `elements[${index}].${optionalTextField} must be a string up to ${MAX_TEXT_FIELD_LENGTH} chars`;
    }
  }

  for (const optionalBoolField of ["enabled", "visible"] as const) {
    if (raw[optionalBoolField] !== undefined && typeof raw[optionalBoolField] !== "boolean") {
      return `elements[${index}].${optionalBoolField} must be boolean when provided`;
    }
  }

  return null;
}

export function validateSessionStartRequest(payload: unknown): ValidationResult<SessionStartRequest> {
  if (!isObject(payload)) {
    return validationError(400, "Request body must be a JSON object");
  }

  const userGoalError = validateStringField(payload.userGoal, "userGoal", MAX_TEXT_FIELD_LENGTH);
  if (userGoalError) {
    return validationError(400, userGoalError);
  }

  return {
    ok: true,
    value: {
      userGoal: safeString(payload.userGoal),
    },
  };
}

export function validatePlanActionRequest(payload: unknown): ValidationResult<PlanActionRequest> {
  if (!isObject(payload)) {
    return validationError(400, "Request body must be a JSON object");
  }

  const body = toSafeObject(payload);

  const sessionIdError = validateStringField(body.sessionId, "sessionId", 120);
  if (sessionIdError) {
    return validationError(400, sessionIdError);
  }

  const userGoalError = validateStringField(body.userGoal, "userGoal", MAX_TEXT_FIELD_LENGTH);
  if (userGoalError) {
    return validationError(400, userGoalError);
  }

  const visibleText = body.visibleText;
  if (!Array.isArray(visibleText)) {
    return validationError(400, "visibleText must be an array of strings");
  }
  if (visibleText.length > MAX_VISIBLE_TEXT_ITEMS) {
    return validationError(400, `visibleText exceeds max items ${MAX_VISIBLE_TEXT_ITEMS}`);
  }
  for (let i = 0; i < visibleText.length; i += 1) {
    const item = visibleText[i];
    if (typeof item !== "string") {
      return validationError(400, `visibleText[${i}] must be a string`);
    }
    if (item.length > MAX_VISIBLE_TEXT_ITEM_LENGTH) {
      return validationError(400, `visibleText[${i}] exceeds max length ${MAX_VISIBLE_TEXT_ITEM_LENGTH}`);
    }
  }

  const elements = body.elements;
  if (!Array.isArray(elements)) {
    return validationError(400, "elements must be an array");
  }
  if (elements.length > MAX_ELEMENTS) {
    return validationError(400, `elements exceeds max count ${MAX_ELEMENTS}`);
  }

  const uniqueIds = new Set<string>();
  for (let i = 0; i < elements.length; i += 1) {
    const err = validateElement(elements[i], i);
    if (err) {
      return validationError(400, err);
    }
    const id = (elements[i] as UIElement).id;
    if (uniqueIds.has(id)) {
      return validationError(400, `elements contains duplicate id: ${id}`);
    }
    uniqueIds.add(id);
  }

  let screenshotBase64: string | undefined;
  let screenshotMimeType: string | undefined;

  if (body.screenshotBase64 !== undefined) {
    if (typeof body.screenshotBase64 !== "string") {
      return validationError(400, "screenshotBase64 must be a base64 string when provided");
    }
    if (typeof body.screenshotMimeType !== "string") {
      return validationError(400, "screenshotMimeType is required when screenshotBase64 is provided");
    }

    screenshotMimeType = body.screenshotMimeType.trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(screenshotMimeType)) {
      return validationError(
        400,
        `Unsupported screenshotMimeType. Allowed: ${Array.from(ALLOWED_IMAGE_MIME_TYPES).join(", ")}`,
      );
    }

    try {
      const decoded = decodeBase64(body.screenshotBase64);
      if (decoded.length > MAX_SCREENSHOT_BYTES) {
        return validationError(400, `Screenshot exceeds max decoded size of ${MAX_SCREENSHOT_BYTES} bytes`);
      }
      screenshotBase64 = body.screenshotBase64;
    } catch (error) {
      return validationError(400, `Invalid screenshotBase64: ${(error as Error).message}`);
    }
  }

  let framesBase64: string[] | undefined;
  if (body.framesBase64 !== undefined) {
    if (!Array.isArray(body.framesBase64)) {
      return validationError(400, "framesBase64 must be an array of base64 strings");
    }
    if (body.framesBase64.length > MAX_FRAMES) {
      return validationError(400, `framesBase64 exceeds max count ${MAX_FRAMES}`);
    }

    framesBase64 = [];
    for (let i = 0; i < body.framesBase64.length; i += 1) {
      const frame = body.framesBase64[i];
      if (typeof frame !== "string") {
        return validationError(400, `framesBase64[${i}] must be a string`);
      }
      try {
        const decoded = decodeBase64(frame);
        if (decoded.length > MAX_SCREENSHOT_BYTES) {
          return validationError(400, `framesBase64[${i}] exceeds max decoded size of ${MAX_SCREENSHOT_BYTES} bytes`);
        }
      } catch (error) {
        return validationError(400, `framesBase64[${i}] is invalid base64: ${(error as Error).message}`);
      }
      framesBase64.push(frame);
    }
  }

  if (elements.length === 0 && visibleText.length === 0 && !screenshotBase64) {
    return validationError(
      400,
      "At least one of elements, visibleText, or screenshotBase64 must be provided",
    );
  }

  const pageUrl = body.pageUrl === undefined ? undefined : safeString(body.pageUrl).slice(0, MAX_TEXT_FIELD_LENGTH);
  const pageTitle =
    body.pageTitle === undefined ? undefined : safeString(body.pageTitle).slice(0, MAX_TEXT_FIELD_LENGTH);

  if (body.screenshotMimeType !== undefined && screenshotBase64 === undefined) {
    return validationError(400, "screenshotMimeType cannot be provided without screenshotBase64");
  }

  if (body.allowNonInteractableGuidance !== undefined && typeof body.allowNonInteractableGuidance !== "boolean") {
    return validationError(400, "allowNonInteractableGuidance must be boolean when provided");
  }

  return {
    ok: true,
    value: {
      sessionId: safeString(body.sessionId),
      userGoal: safeString(body.userGoal),
      pageUrl,
      pageTitle,
      visibleText,
      elements: elements as UIElement[],
      screenshotBase64,
      screenshotMimeType,
      framesBase64,
      allowNonInteractableGuidance: body.allowNonInteractableGuidance as boolean | undefined,
    },
  };
}
