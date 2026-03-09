export const ACTION_TYPES = [
  "highlight",
  "click",
  "type",
  "scroll",
  "wait",
  "ask_user",
  "done",
] as const;

export const ACTION_DIRECTIONS = ["up", "down", "left", "right"] as const;
export const ACTION_AMOUNTS = ["small", "medium", "large"] as const;

export type ActionType = (typeof ACTION_TYPES)[number];
export type ActionDirection = (typeof ACTION_DIRECTIONS)[number];
export type ActionAmount = (typeof ACTION_AMOUNTS)[number];

export interface UIElement {
  id: string;
  text: string;
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
  placeholder?: string;
  value?: string;
  enabled?: boolean;
  visible?: boolean;
}

export interface PlanActionRequest {
  sessionId: string;
  userGoal: string;
  pageUrl?: string;
  pageTitle?: string;
  visibleText: string[];
  elements: UIElement[];
  screenshotBase64?: string;
  screenshotMimeType?: string;
  framesBase64?: string[];
  allowNonInteractableGuidance?: boolean;
}

export interface ActionObject {
  type: ActionType;
  targetId?: string;
  value?: string;
  direction?: ActionDirection;
  amount?: ActionAmount;
  delayMs?: number;
}

export interface ActionGrounding {
  matchedElementIds: string[];
  matchedVisibleText: string[];
  reasoningSummary: string;
}

export interface PlanActionResponse {
  status: "ok" | "need_clarification" | "error";
  message: string;
  action: ActionObject;
  confidence: number;
  grounding: ActionGrounding;
}

export interface SessionStartRequest {
  userGoal: string;
}

export interface SessionStartResponse {
  sessionId: string;
  createdAt: string;
}

export interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ValidationFailure {
  ok: false;
  statusCode: number;
  message: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export interface AppConfig {
  port: number;
  useVertexAI: boolean;
  googleCloudProject: string;
  googleCloudLocation: string;
  geminiActionModel: string;
  geminiLiveModel: string;
  enableLiveApi: boolean;
  maxRequestBytes: number;
}

export interface SessionEvent {
  timestamp: string;
  type: "plan_request" | "plan_response" | "live_event";
  summary: string;
}

export interface SessionRecord {
  sessionId: string;
  userGoal: string;
  createdAt: string;
  lastSeenAt: string;
  history: SessionEvent[];
}

export interface WsStartMessage {
  type: "start";
  sessionId?: string;
  userGoal?: string;
}

export interface WsUserTextMessage {
  type: "user_text";
  text: string;
}

export interface WsUserAudioChunkMessage {
  type: "user_audio_chunk";
  dataBase64: string;
  mimeType?: string;
}

export interface WsUserImageFrameMessage {
  type: "user_image_frame";
  dataBase64: string;
  mimeType: string;
}

export interface WsEndMessage {
  type: "end";
}

export type LiveClientMessage =
  | WsStartMessage
  | WsUserTextMessage
  | WsUserAudioChunkMessage
  | WsUserImageFrameMessage
  | WsEndMessage;

export interface WsErrorMessage {
  type: "error";
  code: string;
  message: string;
  retryable?: boolean;
}

export interface WsModelTextMessage {
  type: "model_text";
  text: string;
}

export interface WsTranscriptMessage {
  type: "transcript";
  role: "system" | "user" | "model";
  text: string;
}

export interface WsPlannedActionMessage {
  type: "planned_action";
  action: ActionObject;
}

export interface WsToolCallMessage {
  type: "tool_call";
  name: string;
  args?: Record<string, unknown>;
}

export type LiveServerMessage =
  | WsErrorMessage
  | WsModelTextMessage
  | WsTranscriptMessage
  | WsPlannedActionMessage
  | WsToolCallMessage;
