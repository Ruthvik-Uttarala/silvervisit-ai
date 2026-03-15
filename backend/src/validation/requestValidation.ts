import {
  PlanActionRequest,
  PortalLifecycleState,
  SandboxAppointment,
  SandboxMessageThread,
  SandboxNoteAvs,
  SandboxPrescription,
  SandboxReferral,
  SandboxReportResult,
  SessionStartRequest,
  UIElement,
  ValidationResult,
} from "../types";
import { decodeBase64, isObject, safeString, sanitizeBase64, toSafeObject } from "../utils";

export const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_SCREENSHOT_BYTES = 7 * 1024 * 1024;
export const MAX_VISIBLE_TEXT_ITEMS = 400;
export const MAX_VISIBLE_TEXT_ITEM_LENGTH = 400;
export const MAX_ELEMENTS = 500;
export const MAX_TEXT_FIELD_LENGTH = 1000;
export const MAX_ELEMENT_TEXT_LENGTH = 500;
export const MAX_FRAMES = 5;
const ALLOWED_PORTAL_STATES = new Set<PortalLifecycleState>([
  "pre_check_in",
  "echeckin_in_progress",
  "device_setup",
  "waiting_room",
  "provider_ready",
  "joined",
]);
const ALLOWED_APPOINTMENT_STATUSES = new Set<SandboxAppointment["status"]>([
  "upcoming",
  "today",
  "ready_to_join",
  "waiting_room",
  "completed",
  "past",
  "canceled",
  "rescheduled",
]);

function isPng(buffer: Buffer): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => buffer[index] === byte);
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isWebp(buffer: Buffer): boolean {
  if (buffer.length < 12) {
    return false;
  }
  const riff = buffer.toString("ascii", 0, 4);
  const webp = buffer.toString("ascii", 8, 12);
  return riff === "RIFF" && webp === "WEBP";
}

export function detectImageMimeType(buffer: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (isPng(buffer)) {
    return "image/png";
  }
  if (isJpeg(buffer)) {
    return "image/jpeg";
  }
  if (isWebp(buffer)) {
    return "image/webp";
  }
  return null;
}

function validateMimeMatchesBytes(mimeType: string, decoded: Buffer, fieldName: string): string | null {
  const detected = detectImageMimeType(decoded);
  if (!detected) {
    return `${fieldName} is not a supported PNG, JPEG, or WEBP image payload`;
  }
  if (detected !== mimeType) {
    return `${fieldName} does not match ${mimeType}; detected ${detected}`;
  }
  return null;
}

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

function validateSandboxFixture(input: unknown): {
  ok: true;
  value: PlanActionRequest["sandboxFixture"];
} | {
  ok: false;
  message: string;
} {
  if (!isObject(input)) {
    return { ok: false, message: "sandboxFixture must be an object when provided." };
  }
  const body = toSafeObject(input);
  const requiredStringFields = [
    "fixtureId",
    "patientName",
    "patientDob",
    "loginSecret",
    "doctorName",
    "appointmentType",
    "clinicLabel",
    "waitingRoomState",
    "clinicianReadyState",
    "appointmentTimeText",
    "visitTitle",
  ] as const;
  for (const field of requiredStringFields) {
    const value = safeString(body[field]);
    if (!value) {
      return { ok: false, message: `sandboxFixture.${field} is required.` };
    }
  }
  const seed = Number(body.seed);
  if (!Number.isFinite(seed) || seed <= 0) {
    return { ok: false, message: "sandboxFixture.seed must be a positive number." };
  }

  const portalStateRaw = safeString(body.portalState);
  const portalState: PortalLifecycleState = ALLOWED_PORTAL_STATES.has(portalStateRaw as PortalLifecycleState)
    ? (portalStateRaw as PortalLifecycleState)
    : "pre_check_in";
  const portalNow = safeString(body.portalNow);

  const appointments: SandboxAppointment[] = Array.isArray(body.appointments)
    ? body.appointments
        .filter((item): item is Record<string, unknown> => isObject(item))
        .flatMap((item) => {
          const status = safeString(item.status) as SandboxAppointment["status"];
          const appointment: SandboxAppointment = {
            appointmentId: safeString(item.appointmentId),
            scheduledDateTime: safeString(item.scheduledDateTime),
            joinWindowStart: safeString(item.joinWindowStart),
            joinWindowEnd: safeString(item.joinWindowEnd),
            status,
            joinableNow: Boolean(item.joinableNow),
            providerName: safeString(item.providerName),
            specialty: safeString(item.specialty),
            visitType: safeString(item.visitType),
            locationLabel: safeString(item.locationLabel),
            note: safeString(item.note) || undefined,
          };

          if (
            !appointment.appointmentId ||
            !appointment.scheduledDateTime ||
            !appointment.joinWindowStart ||
            !appointment.joinWindowEnd ||
            !appointment.providerName ||
            !appointment.specialty ||
            !appointment.visitType ||
            !appointment.locationLabel
          ) {
            return [];
          }
          if (!ALLOWED_APPOINTMENT_STATUSES.has(appointment.status)) {
            return [];
          }
          return [appointment];
        })
    : [];

  const preVisitTasks = Array.isArray(body.preVisitTasks)
    ? body.preVisitTasks
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => ({
          taskId: safeString(item.taskId),
          label: safeString(item.label),
          required: Boolean(item.required),
          completed: Boolean(item.completed),
          section: safeString(item.section),
        }))
        .filter((item) => item.taskId && item.label && item.section)
    : [];

  const deviceChecks = Array.isArray(body.deviceChecks)
    ? body.deviceChecks
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => ({
          checkId: safeString(item.checkId),
          label: safeString(item.label),
          required: Boolean(item.required),
          passed: Boolean(item.passed),
        }))
        .filter((item) => item.checkId && item.label)
    : [];

  const supportPaths = Array.isArray(body.supportPaths)
    ? body.supportPaths
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => ({
          pathId: safeString(item.pathId),
          label: safeString(item.label),
          description: safeString(item.description),
          actionHint: safeString(item.actionHint),
        }))
        .filter((item) => item.pathId && item.label && item.description && item.actionHint)
    : [];

  const pastVisitSummaries = Array.isArray(body.pastVisitSummaries)
    ? body.pastVisitSummaries
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => ({
          visitId: safeString(item.visitId),
          completedDateTime: safeString(item.completedDateTime),
          providerName: safeString(item.providerName),
          specialty: safeString(item.specialty),
          summaryTitle: safeString(item.summaryTitle),
          summarySnippet: safeString(item.summarySnippet),
        }))
        .filter((item) => item.visitId && item.completedDateTime && item.providerName && item.specialty && item.summaryTitle)
    : [];

  const reportsResults: SandboxReportResult[] = Array.isArray(body.reportsResults)
    ? body.reportsResults
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => {
          const status: SandboxReportResult["status"] = safeString(item.status) === "pending" ? "pending" : "final";
          return {
            resultId: safeString(item.resultId),
            appointmentId: safeString(item.appointmentId),
            createdDateTime: safeString(item.createdDateTime),
            providerName: safeString(item.providerName),
            specialty: safeString(item.specialty),
            topic: safeString(item.topic),
            resultType: safeString(item.resultType),
            status,
            summaryTitle: safeString(item.summaryTitle),
            summarySnippet: safeString(item.summarySnippet),
          };
        })
        .filter(
          (item) =>
            item.resultId &&
            item.appointmentId &&
            item.createdDateTime &&
            item.providerName &&
            item.specialty &&
            item.topic &&
            item.resultType &&
            item.summaryTitle,
        )
    : [];

  const notesAvs: SandboxNoteAvs[] = Array.isArray(body.notesAvs)
    ? body.notesAvs
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => ({
          noteId: safeString(item.noteId),
          appointmentId: safeString(item.appointmentId),
          completedDateTime: safeString(item.completedDateTime),
          providerName: safeString(item.providerName),
          specialty: safeString(item.specialty),
          topic: safeString(item.topic),
          summaryTitle: safeString(item.summaryTitle),
          summarySnippet: safeString(item.summarySnippet),
        }))
        .filter(
          (item) =>
            item.noteId &&
            item.appointmentId &&
            item.completedDateTime &&
            item.providerName &&
            item.specialty &&
            item.topic &&
            item.summaryTitle,
        )
    : [];

  const messageThreads: SandboxMessageThread[] = Array.isArray(body.messageThreads)
    ? body.messageThreads
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => ({
          threadId: safeString(item.threadId),
          appointmentId: safeString(item.appointmentId) || undefined,
          updatedDateTime: safeString(item.updatedDateTime),
          providerName: safeString(item.providerName),
          specialty: safeString(item.specialty),
          topic: safeString(item.topic),
          subject: safeString(item.subject),
          preview: safeString(item.preview),
          unreadCount: Math.max(0, Math.floor(Number(item.unreadCount) || 0)),
        }))
        .filter(
          (item) =>
            item.threadId &&
            item.updatedDateTime &&
            item.providerName &&
            item.specialty &&
            item.topic &&
            item.subject &&
            item.preview,
        )
    : [];

  const prescriptions: SandboxPrescription[] = Array.isArray(body.prescriptions)
    ? body.prescriptions
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => {
          const statusRaw = safeString(item.status);
          const status: SandboxPrescription["status"] =
            statusRaw === "completed" || statusRaw === "stopped" ? statusRaw : "active";
          return {
            prescriptionId: safeString(item.prescriptionId),
            appointmentId: safeString(item.appointmentId),
            createdDateTime: safeString(item.createdDateTime),
            providerName: safeString(item.providerName),
            specialty: safeString(item.specialty),
            topic: safeString(item.topic),
            medicationName: safeString(item.medicationName),
            dosage: safeString(item.dosage),
            status,
          };
        })
        .filter(
          (item) =>
            item.prescriptionId &&
            item.appointmentId &&
            item.createdDateTime &&
            item.providerName &&
            item.specialty &&
            item.topic &&
            item.medicationName &&
            item.dosage,
        )
    : [];

  const referrals: SandboxReferral[] = Array.isArray(body.referrals)
    ? body.referrals
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => {
          const statusRaw = safeString(item.status);
          const status: SandboxReferral["status"] =
            statusRaw === "closed" || statusRaw === "scheduled" ? statusRaw : "open";
          return {
            referralId: safeString(item.referralId),
            appointmentId: safeString(item.appointmentId),
            createdDateTime: safeString(item.createdDateTime),
            providerName: safeString(item.providerName),
            specialty: safeString(item.specialty),
            topic: safeString(item.topic),
            referredTo: safeString(item.referredTo),
            referralReason: safeString(item.referralReason),
            status,
          };
        })
        .filter(
          (item) =>
            item.referralId &&
            item.appointmentId &&
            item.createdDateTime &&
            item.providerName &&
            item.specialty &&
            item.topic &&
            item.referredTo &&
            item.referralReason,
        )
    : [];

  const detailsChecklist = Array.isArray(body.detailsChecklist)
    ? body.detailsChecklist.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ok: true,
    value: {
      fixtureId: safeString(body.fixtureId),
      seed: Math.floor(seed),
      patientName: safeString(body.patientName),
      patientDob: safeString(body.patientDob),
      loginSecret: safeString(body.loginSecret),
      doctorName: safeString(body.doctorName),
      appointmentType: safeString(body.appointmentType),
      clinicLabel: safeString(body.clinicLabel),
      waitingRoomState: safeString(body.waitingRoomState),
      clinicianReadyState: safeString(body.clinicianReadyState),
      appointmentTimeText: safeString(body.appointmentTimeText),
      visitTitle: safeString(body.visitTitle),
      detailsChecklist,
      portalNow,
      portalState,
      appointments,
      preVisitTasks,
      deviceChecks,
      supportPaths,
      pastVisitSummaries,
      reportsResults,
      notesAvs,
      messageThreads,
      prescriptions,
      referrals,
    },
  };
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
  const requireScreenshot = body.requireScreenshot === true;

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
      const mimeMismatchError = validateMimeMatchesBytes(screenshotMimeType, decoded, "screenshotBase64");
      if (mimeMismatchError) {
        return validationError(400, mimeMismatchError);
      }
      screenshotBase64 = sanitizeBase64(body.screenshotBase64);
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
        const detectedFrameMime = detectImageMimeType(decoded);
        if (!detectedFrameMime) {
          return validationError(400, `framesBase64[${i}] is not a supported PNG, JPEG, or WEBP image payload`);
        }
        if (screenshotMimeType && detectedFrameMime !== screenshotMimeType) {
          return validationError(
            400,
            `framesBase64[${i}] mime mismatch. Expected ${screenshotMimeType}, detected ${detectedFrameMime}`,
          );
        }
      } catch (error) {
        return validationError(400, `framesBase64[${i}] is invalid base64: ${(error as Error).message}`);
      }
      framesBase64.push(sanitizeBase64(frame));
    }
  }

  if (elements.length === 0 && visibleText.length === 0 && !screenshotBase64) {
    return validationError(
      400,
      "At least one of elements, visibleText, or screenshotBase64 must be provided",
    );
  }

  if (body.requireScreenshot !== undefined && typeof body.requireScreenshot !== "boolean") {
    return validationError(400, "requireScreenshot must be boolean when provided");
  }

  if (requireScreenshot && (!screenshotBase64 || !screenshotMimeType)) {
    return validationError(
      400,
      "Screenshot is required for this planning turn, but screenshot capture data is missing or invalid.",
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

  let sandboxFixture: PlanActionRequest["sandboxFixture"] | undefined;
  if (body.sandboxFixture !== undefined) {
    const parsedFixture = validateSandboxFixture(body.sandboxFixture);
    if (!parsedFixture.ok) {
      return validationError(400, parsedFixture.message);
    }
    sandboxFixture = parsedFixture.value;
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
      requireScreenshot,
      screenshotBase64,
      screenshotMimeType,
      framesBase64,
      allowNonInteractableGuidance: body.allowNonInteractableGuidance as boolean | undefined,
      sandboxFixture,
    },
  };
}
