import { ACTION_PLANNER_SYSTEM_PROMPT } from "./prompts/actionPlannerSystemPrompt";
import {
  ACTION_AMOUNTS,
  ACTION_DIRECTIONS,
  ACTION_TYPES,
  ActionObject,
  AppConfig,
  NavigatorDestination,
  ParsedNavigatorIntent,
  PlanActionRequest,
  PlanActionResponse,
  SessionEvent,
  UIElement,
} from "./types";
import { Logger } from "./logger";
import { getVertexClient } from "./vertex";
import { parseNavigatorIntent } from "./intentParser";
import { clampConfidence, getActionFallback, sanitizeBase64, safeErrorMessage, safeString } from "./utils";

const ACTION_TYPES_SET = new Set<string>(ACTION_TYPES);
const DIRECTION_SET = new Set<string>(ACTION_DIRECTIONS);
const AMOUNT_SET = new Set<string>(ACTION_AMOUNTS);
const REQUIRED_TARGET_TYPES = new Set(["click", "type", "highlight"]);
const PRECISE_DESTINATIONS = new Set<NavigatorDestination>([
  "appointments",
  "reports_results",
  "notes_avs",
  "messages",
  "prescriptions",
  "referrals",
]);

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

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeTargetText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferDestinationFromTarget(target: UIElement): NavigatorDestination {
  const source = normalizeTargetText(
    [target.id, target.text, target.placeholder ?? "", target.value ?? ""].join(" "),
  );
  if (!source) {
    return "unknown";
  }
  if (/\b(message|thread|inbox|secure message)\b/.test(source)) return "messages";
  if (/\b(report|result|lab)\b/.test(source)) return "reports_results";
  if (/\b(note|after visit|avs)\b/.test(source)) return "notes_avs";
  if (/\b(prescription|medication|pharmacy)\b/.test(source)) return "prescriptions";
  if (/\b(referral|referred)\b/.test(source)) return "referrals";
  if (/\b(appointment|visit|join|waiting room|check in|echeck)\b/.test(source)) return "appointments";
  if (/\b(help|support|caregiver|troubleshoot)\b/.test(source)) return "help";
  return "unknown";
}

function hasAmbiguousInteractableTarget(target: UIElement, request: PlanActionRequest): boolean {
  const targetText = normalizeTargetText(target.text);
  if (!targetText) {
    return false;
  }
  let candidates = 0;
  for (const element of request.elements) {
    if (element.id === target.id) {
      continue;
    }
    if (!isInteractableElement(element)) {
      continue;
    }
    if (normalizeTargetText(element.text) === targetText && normalizeTargetText(element.role) === normalizeTargetText(target.role)) {
      candidates += 1;
      if (candidates >= 1) {
        return true;
      }
    }
  }
  return false;
}

type CredentialField = "patient_name" | "patient_dob" | "login_secret";
type CredentialSet = { patientName?: string; patientDob?: string; loginSecret?: string };

interface RankedDestinationCandidate {
  targetId: string;
  score: number;
  reason: string;
  recordSummary: string;
  exactMatch: boolean;
}

interface DestinationResolution {
  action?: ActionObject;
  reasoning: string;
  tie: boolean;
  fallbackUsed: boolean;
  selectedSummary?: string;
  fallbackMessage?: string;
}

function inferIdentityField(target: UIElement): CredentialField | null {
  const source = [
    target.id,
    target.text,
    target.placeholder ?? "",
    target.value ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/(full name|patient name|name)/.test(source)) {
    return "patient_name";
  }
  if (/(date of birth|dob|birth date|birthday)/.test(source)) {
    return "patient_dob";
  }
  if (/(password|passcode|login secret|secret code|security code)/.test(source)) {
    return "login_secret";
  }
  return null;
}

function isSandboxLoginPage(request: PlanActionRequest): boolean {
  const idSet = new Set(request.elements.map((element) => element.id));
  if (!idSet.has("login-full-name-input") || !idSet.has("login-dob-input") || !idSet.has("login-password-input")) {
    return false;
  }
  const hasVisibleCredentialHint = request.visibleText.some((line) => /deterministic credentials/i.test(line));
  if (!hasVisibleCredentialHint) {
    return false;
  }
  const pageUrl = request.pageUrl ?? "";
  return /^https?:\/\/(127\.0\.0\.1|localhost):4173/i.test(pageUrl);
}

function extractVisibleSandboxCredentials(request: PlanActionRequest): CredentialSet | null {
  if (!isSandboxLoginPage(request)) {
    return null;
  }
  for (const line of request.visibleText) {
    const lower = line.toLowerCase();
    const prefix = "deterministic credentials:";
    const startIndex = lower.indexOf(prefix);
    if (startIndex < 0) {
      continue;
    }
    const rawPayload = line.slice(startIndex + prefix.length).trim();
    const canonicalPayload = rawPayload.replace(/\s-\s/g, "|");
    const chunks = canonicalPayload
      .split(/\s*[·|]\s*/g)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (chunks.length < 3) {
      continue;
    }
    const [patientName, patientDob, ...secretParts] = chunks;
    const loginSecret = secretParts.join(" ").trim();
    if (!patientName || !patientDob || !loginSecret) {
      continue;
    }
    return { patientName, patientDob, loginSecret };
  }
  return null;
}
function startOfDayMs(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function parseDateMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePortalNowMs(request: PlanActionRequest): number {
  if (request.sandboxFixture) {
    const fixtureNow = parseDateMs(request.sandboxFixture.portalNow);
    if (fixtureNow !== null) {
      return fixtureNow;
    }
  }
  return Date.now();
}

function parseIntentDateMs(explicitDate: string | undefined, portalNowMs: number): number | null {
  if (!explicitDate) {
    return null;
  }
  const direct = parseDateMs(explicitDate);
  if (direct !== null) {
    return startOfDayMs(direct);
  }
  const year = new Date(portalNowMs).getFullYear();
  const withPortalYear = parseDateMs(`${explicitDate} ${year}`);
  return withPortalYear === null ? null : startOfDayMs(withPortalYear);
}

function parseIntentTimeMinutes(explicitTime: string | undefined): number | null {
  if (!explicitTime) {
    return null;
  }
  const match = explicitTime.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) {
    return null;
  }
  const hourRaw = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minute)) {
    return null;
  }
  let hour = hourRaw % 24;
  const meridiem = (match[3] ?? "").toLowerCase();
  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }
  return hour * 60 + minute;
}

function scoreTemporalFit(
  itemDateIso: string,
  parsedIntent: ParsedNavigatorIntent,
  portalNowMs: number,
): number {
  const itemMs = parseDateMs(itemDateIso);
  if (itemMs === null) {
    return 0;
  }
  let score = 0;
  const portalDay = startOfDayMs(portalNowMs);
  const itemDay = startOfDayMs(itemMs);
  const dayDelta = Math.round((itemDay - portalDay) / 86400000);

  const explicitDay = parseIntentDateMs(parsedIntent.explicitDate, portalNowMs);
  if (explicitDay !== null) {
    const diffDays = Math.abs(Math.round((itemDay - explicitDay) / 86400000));
    if (diffDays === 0) {
      score += 46;
    } else {
      score -= Math.min(24, diffDays * 6);
    }
  }

  const explicitMinutes = parseIntentTimeMinutes(parsedIntent.explicitTime);
  if (explicitMinutes !== null) {
    const itemDate = new Date(itemMs);
    const itemMinutes = itemDate.getHours() * 60 + itemDate.getMinutes();
    const diff = Math.abs(itemMinutes - explicitMinutes);
    if (diff <= 20) score += 24;
    else if (diff <= 60) score += 12;
    else if (diff <= 150) score += 4;
    else score -= Math.min(18, Math.round(diff / 30));
  }

  const cues = new Set(parsedIntent.temporalCues);
  if (cues.has("today")) score += dayDelta === 0 ? 34 : -10;
  if (cues.has("tomorrow")) score += dayDelta === 1 ? 28 : -8;
  if (cues.has("yesterday")) score += dayDelta === -1 ? 28 : -8;
  if (cues.has("last_week")) score += dayDelta < 0 && dayDelta >= -7 ? 20 : -6;
  if (cues.has("this_afternoon")) {
    const hour = new Date(itemMs).getHours();
    score += hour >= 12 && hour < 18 ? 12 : -4;
  }
  if (cues.has("this_morning")) {
    const hour = new Date(itemMs).getHours();
    score += hour >= 6 && hour < 12 ? 12 : -4;
  }
  if (cues.has("latest") || cues.has("recent") || cues.has("current") || cues.has("newest") || cues.has("most_recent") || cues.has("just_had") || cues.has("last_visit")) {
    if (itemMs <= portalNowMs) {
      score += 12;
      score += Math.max(0, 10 - Math.floor((portalNowMs - itemMs) / 86400000));
    }
  }

  return score;
}

function scoreMatchTerm(term: string | undefined, candidate: string | undefined, weight: number): number {
  const normalizedTerm = normalizeTargetText(term ?? "");
  const normalizedCandidate = normalizeTargetText(candidate ?? "");
  if (!normalizedTerm || !normalizedCandidate) {
    return 0;
  }
  if (normalizedCandidate.includes(normalizedTerm) || normalizedTerm.includes(normalizedCandidate)) {
    return weight;
  }
  return 0;
}

function summarizeRequestedConstraints(parsedIntent: ParsedNavigatorIntent): string {
  const parts: string[] = [];
  if (parsedIntent.explicitDate) parts.push(parsedIntent.explicitDate);
  if (parsedIntent.explicitTime) parts.push(parsedIntent.explicitTime);
  if (parsedIntent.topic) parts.push(parsedIntent.topic);
  if (parsedIntent.providerName) parts.push(parsedIntent.providerName);
  if (parsedIntent.specialty) parts.push(parsedIntent.specialty);
  if (parts.length === 0) {
    if (parsedIntent.temporalCues.includes("latest") || parsedIntent.temporalCues.includes("recent")) {
      return "the latest item";
    }
    return "your requested item";
  }
  return parts.join(" / ");
}

function buildRecordSummary(record: any, isoDate: string): string {
  const dateLabel = isoDate ? new Date(isoDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const provider = record.providerName ?? "";
  const topic = record.topic ?? record.visitType ?? record.referredTo ?? record.subject ?? "";
  return [dateLabel, provider, topic].filter(Boolean).join(" - ");
}

function hasTermMatch(term: string | undefined, ...candidates: Array<string | undefined>): boolean {
  const normalizedTerm = normalizeTargetText(term ?? "");
  if (!normalizedTerm) {
    return true;
  }
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeTargetText(candidate ?? "");
    return normalizedCandidate.includes(normalizedTerm) || normalizedTerm.includes(normalizedCandidate);
  });
}

function selectRankedCandidate(candidates: RankedDestinationCandidate[]): { best?: RankedDestinationCandidate; tie: boolean } {
  if (candidates.length === 0) {
    return { tie: false };
  }
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  const tie = Boolean(second && Math.abs(best.score - second.score) <= 2);
  return { best, tie };
}

function resolveDestinationCandidateAction(
  request: PlanActionRequest,
  parsedIntent: ParsedNavigatorIntent,
): DestinationResolution {
  const fixture = request.sandboxFixture;
  if (!fixture || !PRECISE_DESTINATIONS.has(parsedIntent.destination)) {
    return { reasoning: "No deterministic destination candidate resolver for this turn.", tie: false, fallbackUsed: false };
  }
  const portalNowMs = parsePortalNowMs(request);
  const interactableElements = request.elements.filter((element) => isInteractableElement(element));
  const candidates: RankedDestinationCandidate[] = [];
  const requestedDateDay = parseIntentDateMs(parsedIntent.explicitDate, portalNowMs);
  const requestedTime = parseIntentTimeMinutes(parsedIntent.explicitTime);

  for (const element of interactableElements) {
    let record: any = null;
    let isoDate: string | null = null;

    if (parsedIntent.destination === "reports_results") {
      const match = element.id.match(/^open-report-result-(.+)-btn$/);
      if (!match) continue;
      record = fixture.reportsResults.find((item) => item.resultId === match[1]) ?? null;
      isoDate = record?.createdDateTime ?? null;
    } else if (parsedIntent.destination === "notes_avs") {
      const match = element.id.match(/^open-note-avs-(.+)-btn$/);
      if (!match) continue;
      record = fixture.notesAvs.find((item) => item.noteId === match[1]) ?? null;
      isoDate = record?.completedDateTime ?? null;
    } else if (parsedIntent.destination === "messages") {
      const match = element.id.match(/^open-message-thread-(.+)-btn$/);
      if (!match) continue;
      record = fixture.messageThreads.find((item) => item.threadId === match[1]) ?? null;
      isoDate = record?.updatedDateTime ?? null;
    } else if (parsedIntent.destination === "prescriptions") {
      const match = element.id.match(/^open-prescription-(.+)-btn$/);
      if (!match) continue;
      record = fixture.prescriptions.find((item) => item.prescriptionId === match[1]) ?? null;
      isoDate = record?.createdDateTime ?? null;
    } else if (parsedIntent.destination === "referrals") {
      const match = element.id.match(/^open-referral-(.+)-btn$/);
      if (!match) continue;
      record = fixture.referrals.find((item) => item.referralId === match[1]) ?? null;
      isoDate = record?.createdDateTime ?? null;
    } else if (parsedIntent.destination === "appointments") {
      const match = element.id.match(/^open-(?:past-)?appointment(?:-details)?-(.+)-btn$/);
      if (!match) continue;
      record = fixture.appointments.find((item) => item.appointmentId === match[1]) ?? null;
      isoDate = record?.scheduledDateTime ?? null;
    }

    if (!record || !isoDate) {
      continue;
    }

    const recordMs = parseDateMs(isoDate);
    if (recordMs === null) {
      continue;
    }
    const recordDay = startOfDayMs(recordMs);
    const recordMinutes = new Date(recordMs).getHours() * 60 + new Date(recordMs).getMinutes();
    const dateMatch = requestedDateDay === null ? true : requestedDateDay === recordDay;
    const timeMatch = requestedTime === null ? true : Math.abs(recordMinutes - requestedTime) <= 40;
    const topicMatch = hasTermMatch(
      parsedIntent.topic,
      record.topic,
      record.referredTo,
      record.referralReason,
      record.summaryTitle,
      record.subject,
      record.medicationName,
      record.visitType,
    );
    const providerMatch = hasTermMatch(parsedIntent.providerName, record.providerName);
    const specialtyMatch = hasTermMatch(parsedIntent.specialty, record.specialty);
    const exactMatch = dateMatch && timeMatch && topicMatch && providerMatch && specialtyMatch;

    let score = 50;
    score += scoreTemporalFit(isoDate, parsedIntent, portalNowMs);
    score += scoreMatchTerm(parsedIntent.providerName, record.providerName, 24);
    score += scoreMatchTerm(parsedIntent.specialty, record.specialty, 18);
    // Topic intent must outrank date-only similarity in same-day ambiguity.
    score += scoreMatchTerm(parsedIntent.topic, record.topic ?? record.visitType, 78);
    score += scoreMatchTerm(parsedIntent.topic, record.referredTo ?? record.subject ?? record.summaryTitle, 66);
    if (parsedIntent.topic && !topicMatch) {
      score -= 34;
    }
    if (parsedIntent.destination === "appointments") {
      if (record.joinableNow === true) score += 35;
      if (record.status === "waiting_room" || record.status === "ready_to_join") score += 22;
      if (record.status === "today") score += 10;
      if (record.status === "past" || record.status === "completed" || record.status === "canceled") score -= 22;
    }

    const reasoningParts: string[] = [];
    if (topicMatch && parsedIntent.topic) reasoningParts.push(`topic "${parsedIntent.topic}"`);
    if (providerMatch && parsedIntent.providerName) reasoningParts.push(`provider "${parsedIntent.providerName}"`);
    if (specialtyMatch && parsedIntent.specialty) reasoningParts.push(`specialty "${parsedIntent.specialty}"`);
    if (dateMatch && parsedIntent.explicitDate) reasoningParts.push(`date "${parsedIntent.explicitDate}"`);
    if (timeMatch && parsedIntent.explicitTime) reasoningParts.push(`time "${parsedIntent.explicitTime}"`);
    if (reasoningParts.length === 0 && parsedIntent.temporalCues.length > 0) {
      reasoningParts.push(`temporal cue "${parsedIntent.temporalCues[0]}"`);
    }
    const reasonSummary = reasoningParts.length > 0 ? reasoningParts.join(", ") : "overall evidence fit";

    candidates.push({
      targetId: element.id,
      score,
      reason: reasonSummary,
      recordSummary: buildRecordSummary(record, isoDate),
      exactMatch,
    });
  }

  const ranked = selectRankedCandidate(candidates);
  if (!ranked.best) {
    return {
      reasoning: "No visible item-level destination candidate is available on this screen.",
      tie: false,
      fallbackUsed: false,
    };
  }
  if (ranked.tie) {
    return {
      reasoning: "Multiple similarly-ranked destination items are visible.",
      tie: true,
      fallbackUsed: false,
    };
  }
  const hasAnyExactMatch = candidates.some((candidate) => candidate.exactMatch);
  const fallbackUsed = !ranked.best.exactMatch && !hasAnyExactMatch;
  const requestedSummary = summarizeRequestedConstraints(parsedIntent);
  const fallbackMessage = fallbackUsed
    ? `I couldn't find an exact match for ${requestedSummary}. I opened the closest grounded match: ${ranked.best.recordSummary} because it best matches ${ranked.best.reason}.`
    : undefined;
  return {
    action: {
      type: "click",
      targetId: ranked.best.targetId,
    },
    reasoning: `Selected unique best destination candidate ${ranked.best.targetId} based on ${ranked.best.reason}.`,
    tie: false,
    fallbackUsed,
    selectedSummary: ranked.best.recordSummary,
    fallbackMessage,
  };
}

function hasDestinationCompletionEvidence(request: PlanActionRequest, parsedIntent: ParsedNavigatorIntent): boolean {
  const visible = request.visibleText.join(" ").toLowerCase();
  const ids = new Set(request.elements.map((element) => element.id));
  if (parsedIntent.destination === "appointments") {
    return hasJoinedEvidence(request);
  }
  if (parsedIntent.destination === "reports_results") {
    return ids.has("report-return-appointment-btn") || visible.includes("return to related appointment");
  }
  if (parsedIntent.destination === "messages") {
    return ids.has("send-secure-message-btn") || ids.has("return-to-messages-btn") || visible.includes("message thread");
  }
  if (parsedIntent.destination === "notes_avs") {
    return ids.has("note-detail-card");
  }
  if (parsedIntent.destination === "prescriptions") {
    return ids.has("prescription-detail-card");
  }
  if (parsedIntent.destination === "referrals") {
    return ids.has("referral-detail-card");
  }
  return false;
}

function getIntentCredentialValue(
  parsedIntent: ParsedNavigatorIntent,
  field: CredentialField,
  fallbackCredentials?: CredentialSet | null,
): string | null {
  if (field === "patient_name") {
    return parsedIntent.patientName?.trim() || fallbackCredentials?.patientName?.trim() || null;
  }
  if (field === "patient_dob") {
    return parsedIntent.dob?.trim() || fallbackCredentials?.patientDob?.trim() || null;
  }
  return parsedIntent.loginSecret?.trim() || fallbackCredentials?.loginSecret?.trim() || null;
}

function detectCredentialActionFromPage(
  request: PlanActionRequest,
  parsedIntent: ParsedNavigatorIntent,
): { typeAction?: ActionObject; clarification?: string; reasoning: string } {
  const visibleCredentials = extractVisibleSandboxCredentials(request);
  const candidates = new Map<CredentialField, UIElement[]>();
  for (const element of request.elements) {
    if (!isInteractableElement(element)) {
      continue;
    }
    const field = inferIdentityField(element);
    if (!field) {
      continue;
    }
    const existing = candidates.get(field) ?? [];
    existing.push(element);
    candidates.set(field, existing);
  }

  if (candidates.size === 0) {
    return { reasoning: "No visible enabled login/check-in fields were detected." };
  }

  const orderedFields: CredentialField[] = ["patient_name", "patient_dob", "login_secret"];
  const missingFields: string[] = [];
  for (const field of orderedFields) {
    if (!candidates.has(field)) {
      continue;
    }
    const value = getIntentCredentialValue(parsedIntent, field, visibleCredentials);
    if (!value) {
      if (field === "patient_name") missingFields.push("full name");
      if (field === "patient_dob") missingFields.push("date of birth");
      if (field === "login_secret") missingFields.push("password");
    }
  }
  if (missingFields.length > 0) {
    return {
      clarification: `Please provide your ${missingFields.join(" and ")} so I can continue the sign-in step.`,
      reasoning: "Required visible login/check-in fields are missing user-provided values.",
    };
  }

  for (const field of orderedFields) {
    const fieldCandidates = candidates.get(field);
    if (!fieldCandidates || fieldCandidates.length === 0) {
      continue;
    }
    if (fieldCandidates.length > 1) {
      return {
        clarification: "I found more than one matching login field, so I need clarification before typing.",
        reasoning: `Ambiguous login/check-in field matches detected for ${field}.`,
      };
    }
    const target = fieldCandidates[0];
    const value = getIntentCredentialValue(parsedIntent, field, visibleCredentials);
    if (!value) {
      continue;
    }
    if (normalizeComparable(target.value ?? "") === normalizeComparable(value)) {
      continue;
    }
    return {
      typeAction: {
        type: "type",
        targetId: target.id,
        value,
      },
      reasoning: `Visible enabled ${field} field matched with user-provided credential value.`,
    };
  }

  const continueButton = request.elements.find(
    (element) => element.id === "login-continue-btn" && isInteractableElement(element),
  );
  if (continueButton) {
    return {
      typeAction: {
        type: "click",
        targetId: continueButton.id,
      },
      reasoning: "Login credentials are complete and continue is available.",
    };
  }

  return {
    reasoning: "Visible login/check-in fields already match provided values or no typing action is needed.",
  };
}

function hasJoinedEvidence(request: PlanActionRequest): boolean {
  return request.visibleText.some((line) => /\bjoined\b|\bin call\b|\bvisit connected\b/i.test(line));
}

function hasIdentityConflict(request: PlanActionRequest, parsedIntent: ParsedNavigatorIntent): boolean {
  if (!request.sandboxFixture) {
    return false;
  }
  const fixture = request.sandboxFixture;
  const nameConflict =
    typeof parsedIntent.patientName === "string" &&
    parsedIntent.patientName.trim().length > 0 &&
    normalizeComparable(parsedIntent.patientName) !== normalizeComparable(fixture.patientName);
  const dobConflict =
    typeof parsedIntent.dob === "string" &&
    parsedIntent.dob.trim().length > 0 &&
    normalizeComparable(parsedIntent.dob) !== normalizeComparable(fixture.patientDob);
  return nameConflict || dobConflict;
}

function enforceGuardrailsInternal(
  candidate: PlanActionResponse,
  request: PlanActionRequest,
  parsedIntent: ParsedNavigatorIntent,
): PlanActionResponse {
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

    if (
      REQUIRED_TARGET_TYPES.has(response.action.type) &&
      hasAmbiguousInteractableTarget(target, request)
    ) {
      return buildAskUser(
        "I found more than one possible match for that control, so I need clarification.",
        "Multiple interactable controls share the same visible label and role.",
      );
    }

    if (
      PRECISE_DESTINATIONS.has(parsedIntent.destination) &&
      REQUIRED_TARGET_TYPES.has(response.action.type)
    ) {
      const targetDestination = inferDestinationFromTarget(target);
      if (
        targetDestination !== "unknown" &&
        targetDestination !== parsedIntent.destination
      ) {
        return buildAskUser(
          "I found a control, but it appears to lead to a different section than you requested.",
          `Target destination ${targetDestination} conflicts with requested destination ${parsedIntent.destination}.`,
        );
      }
    }
  }

  if (PRECISE_DESTINATIONS.has(parsedIntent.destination)) {
    const rankedDestination = resolveDestinationCandidateAction(request, parsedIntent);
    if (rankedDestination.tie) {
      return buildAskUser(
        "I found more than one possible match, so I need clarification.",
        rankedDestination.reasoning,
      );
    }
    if (rankedDestination.action?.targetId) {
      const shouldReplaceWithExactItem =
        response.action.type === "ask_user" ||
        response.action.type === "done" ||
        (response.action.type === "click" &&
          (!!response.action.targetId?.startsWith("nav-") ||
            response.action.targetId !== rankedDestination.action.targetId));
      if (shouldReplaceWithExactItem) {
        return {
          status: "ok",
          message:
            rankedDestination.fallbackMessage ??
            "I found the best matching item and will open it now.",
          action: rankedDestination.action,
          confidence: Math.max(response.confidence, 0.68),
          grounding: {
            matchedElementIds: [rankedDestination.action.targetId!],
            matchedVisibleText: response.grounding.matchedVisibleText,
            reasoningSummary: rankedDestination.reasoning.slice(0, 240),
          },
        };
      }
    }
  }

  if (response.action.type === "type" && !response.action.value) {
    return buildAskUser(
      "I need the text to enter before continuing.",
      "The typing action did not include a grounded input value.",
    );
  }

  if (response.action.type === "type" && response.action.targetId) {
    const target = elementMap.get(response.action.targetId);
    if (target) {
      const identityField = inferIdentityField(target);
      if (identityField === "patient_name" && parsedIntent.patientName) {
        response.action.value = parsedIntent.patientName;
      }
      if (identityField === "patient_dob" && parsedIntent.dob) {
        response.action.value = parsedIntent.dob;
      }
      if (identityField === "login_secret" && parsedIntent.loginSecret) {
        response.action.value = parsedIntent.loginSecret;
      }
    }
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

  if (
    response.action.type === "done" &&
    !hasDestinationCompletionEvidence(request, parsedIntent)
  ) {
    return buildAskUser(
      parsedIntent.destination === "appointments"
        ? "You are not fully joined yet. I will keep guiding the next safe step."
        : "I reached the section, but not the exact requested item yet. I will keep guiding.",
      "Done was blocked because explicit end-goal evidence is not visible on this screen.",
    );
  }

  if (hasIdentityConflict(request, parsedIntent) && response.action.type === "type") {
    return buildAskUser(
      "The provided name or date of birth does not match this portal account. Please confirm which patient profile to use.",
      "User-provided identity conflicts with the active sandbox fixture, so auto-typing is blocked for safety.",
    );
  }

  if (response.status === "need_clarification" || response.action.type === "ask_user") {
    const credentialResolution = detectCredentialActionFromPage(request, parsedIntent);
    if (credentialResolution.typeAction) {
      return {
        status: "ok",
        message:
          credentialResolution.typeAction.type === "click"
            ? "I found the login prerequisite and will continue safely."
            : "I found the login/check-in field and will enter the value you provided.",
        action: credentialResolution.typeAction,
        confidence: Math.max(response.confidence, 0.65),
        grounding: {
          matchedElementIds: credentialResolution.typeAction.targetId
            ? [credentialResolution.typeAction.targetId]
            : [],
          matchedVisibleText: response.grounding.matchedVisibleText,
          reasoningSummary: credentialResolution.reasoning.slice(0, 240),
        },
      };
    }
    if (credentialResolution.clarification) {
      return buildAskUser(credentialResolution.clarification, credentialResolution.reasoning);
    }
  }

  return response;
}

export function enforcePlannerGuardrailsForTesting(
  candidate: PlanActionResponse,
  request: PlanActionRequest,
  parsedIntent: ParsedNavigatorIntent,
): PlanActionResponse {
  return enforceGuardrailsInternal(candidate, request, parsedIntent);
}

function normalizeModelOutput(
  rawObject: Record<string, unknown>,
  request: PlanActionRequest,
  parsedIntent: ParsedNavigatorIntent,
): PlanActionResponse {
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

  return enforceGuardrailsInternal(normalized, request, parsedIntent);
}

function buildUserPayload(
  request: PlanActionRequest,
  recentHistory: SessionEvent[],
  parsedIntent: ParsedNavigatorIntent,
): string {
  const payload = {
    task: "Pick exactly one best next UI action for a telehealth flow.",
    constraints: {
      groundedOnly: true,
      noInventedIds: true,
      askUserIfAmbiguous: true,
      respectHiddenDisabled: true,
      destinationCorrectness: true,
      avoidPrematureJoined: true,
      useUserProvidedIdentityWhenPresent: true,
    },
    context: {
      sessionId: request.sessionId,
      userGoal: request.userGoal,
      parsedIntent,
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

function buildDeterministicResponse(
  message: string,
  action: ActionObject,
  reasoningSummary: string,
  confidence = 0.72,
): PlanActionResponse {
  return {
    status: "ok",
    message,
    action,
    confidence: clampConfidence(confidence),
    grounding: {
      matchedElementIds: action.targetId ? [action.targetId] : [],
      matchedVisibleText: [],
      reasoningSummary: reasoningSummary.slice(0, 240),
    },
  };
}

type JoinSubflowStage =
  | "login"
  | "appointment_details"
  | "echeckin"
  | "device_setup"
  | "waiting_room"
  | "dashboard"
  | "unknown";

function hasVisiblePhrase(request: PlanActionRequest, pattern: RegExp): boolean {
  return request.visibleText.some((line) => pattern.test(line));
}

function inferJoinSubflowStage(request: PlanActionRequest): JoinSubflowStage {
  const ids = new Set(request.elements.map((element) => element.id));
  if (
    ids.has("login-full-name-input") ||
    ids.has("login-dob-input") ||
    ids.has("login-password-input")
  ) {
    return "login";
  }
  if (ids.has("details-start-echeckin-btn") || ids.has("details-open-device-setup-btn")) {
    return "appointment_details";
  }
  if (
    ids.has("echeckin-finish-btn") ||
    request.elements.some((element) => /^complete-.+-btn$/i.test(element.id)) ||
    hasVisiblePhrase(request, /\becheck-?in\b/i)
  ) {
    return "echeckin";
  }
  if (
    ids.has("finish-device-test-btn") ||
    request.elements.some((element) => /^run-device-.+-btn$/i.test(element.id)) ||
    hasVisiblePhrase(request, /\bdevice setup\b/i)
  ) {
    return "device_setup";
  }
  if (
    ids.has("waiting-check-provider-ready-btn") ||
    ids.has("enter-call-btn") ||
    hasVisiblePhrase(request, /\bwaiting room\b/i)
  ) {
    return "waiting_room";
  }
  if (ids.has("dashboard-open-upcoming-btn")) {
    return "dashboard";
  }
  return "unknown";
}

function resolveObviousNextAction(
  request: PlanActionRequest,
  parsedIntent: ParsedNavigatorIntent,
): PlanActionResponse | null {
  const credentialResolution = detectCredentialActionFromPage(request, parsedIntent);
  if (credentialResolution.typeAction) {
    return buildDeterministicResponse(
      credentialResolution.typeAction.type === "click"
        ? "I found the login prerequisite and will continue."
        : "I found the login/check-in field and will enter the value.",
      credentialResolution.typeAction,
      credentialResolution.reasoning,
      0.76,
    );
  }
  if (credentialResolution.clarification && isSandboxLoginPage(request)) {
    return buildAskUser(credentialResolution.clarification, credentialResolution.reasoning);
  }

  if (PRECISE_DESTINATIONS.has(parsedIntent.destination)) {
    const rankedDestination = resolveDestinationCandidateAction(request, parsedIntent);
    if (rankedDestination.tie) {
      return buildAskUser(
        "I found more than one possible match, so I need clarification.",
        rankedDestination.reasoning,
      );
    }
    if (rankedDestination.action?.targetId) {
      return buildDeterministicResponse(
        rankedDestination.fallbackMessage ??
          "I found the best matching item and will open it now.",
        rankedDestination.action,
        rankedDestination.reasoning,
        0.74,
      );
    }
  }

  const intentIsJoinFlow = parsedIntent.destination === "appointments" || parsedIntent.actionVerb === "join";
  if (!intentIsJoinFlow) {
    return null;
  }

  const elementMap = new Map(request.elements.map((element) => [element.id, element]));
  const stage = inferJoinSubflowStage(request);

  if (stage === "appointment_details") {
    const detailIds = [
      "recover-correct-appointment-btn",
      "details-start-echeckin-btn",
      "details-open-device-setup-btn",
      "details-enter-waiting-room-btn",
    ];
    for (const id of detailIds) {
      const target = elementMap.get(id);
      if (!isInteractableElement(target)) {
        continue;
      }
      return buildDeterministicResponse(
        "I found the next required step in your appointment flow and will continue.",
        { type: "click", targetId: id },
        `Join-flow stage ${stage} selected ${id}.`,
        0.72,
      );
    }
  }

  if (stage === "echeckin") {
    const nextTask = request.elements.find(
      (element) =>
        /^complete-.+-btn$/i.test(element.id) &&
        isInteractableElement(element) &&
        !/completed/i.test(element.text),
    );
    if (nextTask) {
      return buildDeterministicResponse(
        "I found the next required eCheck-In task and will complete it.",
        { type: "click", targetId: nextTask.id },
        `Join-flow stage echeckin selected required task ${nextTask.id}.`,
        0.72,
      );
    }
    const finishEcheckin = elementMap.get("echeckin-finish-btn");
    if (isInteractableElement(finishEcheckin)) {
      return buildDeterministicResponse(
        "eCheck-In is ready to finish, so I will continue to the next prerequisite.",
        { type: "click", targetId: "echeckin-finish-btn" },
        "Join-flow stage echeckin selected echeckin-finish-btn.",
        0.72,
      );
    }
    // Stay inside the active subflow instead of looping back to top navigation.
    return buildDeterministicResponse(
      "The next eCheck-In control is likely below the fold, so I will scroll to continue this flow.",
      { type: "scroll", direction: "down", amount: "medium" },
      "Join-flow stage echeckin used scroll progression to avoid nav loopback.",
      0.7,
    );
  }

  if (stage === "device_setup") {
    const nextDeviceCheck = request.elements.find(
      (element) =>
        /^run-device-.+-btn$/i.test(element.id) &&
        isInteractableElement(element) &&
        !/passed/i.test(element.text),
    );
    if (nextDeviceCheck) {
      return buildDeterministicResponse(
        "I found the next required device check and will run it.",
        { type: "click", targetId: nextDeviceCheck.id },
        `Join-flow stage device_setup selected ${nextDeviceCheck.id}.`,
        0.72,
      );
    }
    const finishDevice = elementMap.get("finish-device-test-btn");
    if (isInteractableElement(finishDevice)) {
      return buildDeterministicResponse(
        "Device checks are ready, so I will continue to waiting room progression.",
        { type: "click", targetId: "finish-device-test-btn" },
        "Join-flow stage device_setup selected finish-device-test-btn.",
        0.72,
      );
    }
    return buildDeterministicResponse(
      "The next device setup control is likely below the fold, so I will scroll to continue.",
      { type: "scroll", direction: "down", amount: "medium" },
      "Join-flow stage device_setup used scroll progression to avoid nav loopback.",
      0.7,
    );
  }

  if (stage === "waiting_room") {
    const enterCall = elementMap.get("enter-call-btn");
    if (isInteractableElement(enterCall)) {
      return buildDeterministicResponse(
        "I found Enter Call and will continue to complete your join goal.",
        { type: "click", targetId: "enter-call-btn" },
        "Join-flow stage waiting_room selected enter-call-btn.",
        0.73,
      );
    }
    const refreshReady = elementMap.get("waiting-check-provider-ready-btn");
    if (isInteractableElement(refreshReady)) {
      return buildDeterministicResponse(
        "You are not joined yet, so I will refresh provider readiness in the waiting room.",
        { type: "click", targetId: "waiting-check-provider-ready-btn" },
        "Join-flow stage waiting_room selected waiting-check-provider-ready-btn.",
        0.71,
      );
    }
  }

  if (stage === "dashboard") {
    const dashboardUpcoming = elementMap.get("dashboard-open-upcoming-btn");
    if (isInteractableElement(dashboardUpcoming)) {
      return buildDeterministicResponse(
        "I found the next appointment navigation step and will continue.",
        { type: "click", targetId: "dashboard-open-upcoming-btn" },
        "Join-flow stage dashboard selected dashboard-open-upcoming-btn.",
        0.7,
      );
    }
  }

  const prioritizedIds = [
    "recover-correct-appointment-btn",
    "enter-call-btn",
    "waiting-check-provider-ready-btn",
    "details-enter-waiting-room-btn",
    "details-start-echeckin-btn",
    "echeckin-finish-btn",
    "details-open-device-setup-btn",
    "finish-device-test-btn",
    "dashboard-open-upcoming-btn",
  ];
  for (const id of prioritizedIds) {
    const target = elementMap.get(id);
    if (!isInteractableElement(target)) {
      continue;
    }
    return buildDeterministicResponse(
      "I found an obvious next safe step and will continue.",
      {
        type: "click",
        targetId: id,
      },
      `Obvious next-step resolver selected ${id} for join-flow continuation.`,
      0.7,
    );
  }

  const navUpcoming = elementMap.get("nav-upcoming-btn");
  if (isInteractableElement(navUpcoming) && stage === "unknown") {
    return buildDeterministicResponse(
      "I found the appointment navigation control and will continue.",
      { type: "click", targetId: "nav-upcoming-btn" },
      "Join-flow fallback selected nav-upcoming-btn only after downstream subflow checks.",
      0.68,
    );
  }

  return null;
}

export function resolveObviousNextActionForTesting(
  request: PlanActionRequest,
  parsedIntent: ParsedNavigatorIntent,
): PlanActionResponse | null {
  return resolveObviousNextAction(request, parsedIntent);
}

export async function planNextAction(request: PlanActionRequest, context: PlannerContext): Promise<PlanActionResponse> {
  const parsedIntent = parseNavigatorIntent(request.userGoal);

  if (request.requireScreenshot && (!request.screenshotBase64 || !request.screenshotMimeType)) {
    return buildAskUser(
      "I can't continue because screenshot capture failed.",
      "Screenshot-backed planning is required for this turn, but screenshot payload is missing.",
      "error",
    );
  }

  if (hasIdentityConflict(request, parsedIntent)) {
    return buildAskUser(
      "I found a mismatch between your provided patient details and the current portal account. Please confirm the correct identity before I continue.",
      "Identity conflict detected between user-provided name/date of birth and active fixture context.",
    );
  }

  const deterministicNext = resolveObviousNextAction(request, parsedIntent);
  if (deterministicNext) {
    return deterministicNext;
  }

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
      text: buildUserPayload(request, context.recentHistory, parsedIntent),
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

    return normalizeModelOutput(parsed, request, parsedIntent);
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



