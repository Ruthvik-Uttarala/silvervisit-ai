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
  requireScreenshot?: boolean;
  screenshotBase64?: string;
  screenshotMimeType?: string;
  framesBase64?: string[];
  allowNonInteractableGuidance?: boolean;
  sandboxFixture?: SandboxFixtureContext;
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
  aiProvider: "gemini_api" | "vertex";
  geminiApiKey: string;
  useVertexAI: boolean;
  googleCloudProject: string;
  googleCloudLocation: string;
  geminiActionModel: string;
  geminiLiveModel: string;
  enableLiveApi: boolean;
  persistenceProvider: "supabase" | "firestore";
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabasePublishableKey: string;
  enableFirestore: boolean;
  firestoreCollectionPrefix: string;
  maxRequestBytes: number;
  httpRequestTimeoutMs: number;
  httpHeadersTimeoutMs: number;
  httpKeepAliveTimeoutMs: number;
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
  messageId?: string;
}

export interface WsUserTextMessage {
  type: "user_text";
  text: string;
  messageId?: string;
  turnId?: string;
}

export interface WsUserAudioChunkMessage {
  type: "user_audio_chunk";
  dataBase64?: string;
  mimeType?: string;
  audioStreamEnd?: boolean;
  messageId?: string;
  turnId?: string;
}

export interface WsUserImageFrameMessage {
  type: "user_image_frame";
  dataBase64: string;
  mimeType: string;
  messageId?: string;
  turnId?: string;
}

export interface WsEndMessage {
  type: "end";
  messageId?: string;
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
