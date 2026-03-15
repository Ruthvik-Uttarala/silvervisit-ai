export const ACTION_TYPES = ["highlight", "click", "type", "scroll", "wait", "ask_user", "done"] as const;
export const ACTION_DIRECTIONS = ["up", "down", "left", "right"] as const;
export const ACTION_AMOUNTS = ["small", "medium", "large"] as const;

export type ActionType = (typeof ACTION_TYPES)[number];
export type ActionDirection = (typeof ACTION_DIRECTIONS)[number];
export type ActionAmount = (typeof ACTION_AMOUNTS)[number];

export interface UIElementSnapshot {
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

export interface PageSnapshot {
  pageUrl: string;
  pageTitle: string;
  visibleText: string[];
  elements: UIElementSnapshot[];
}

export interface ScreenshotCapture {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

export interface PageContextWithScreenshot {
  tab: ActiveTabInfo;
  snapshot: PageSnapshot;
  screenshot: ScreenshotCapture;
}

export interface SessionStartRequest {
  userGoal: string;
}

export interface SessionStartResponse {
  sessionId: string;
  createdAt: string;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  useVertexAI: boolean;
  liveEnabled: boolean;
  liveApiConfigured: boolean;
  vertexConfigured: boolean;
  plannerModel: string;
  liveModel: string;
  googleCloudProjectConfigured: boolean;
  googleCloudLocation: string;
  firestoreConfigured: boolean;
  firestoreMode: "emulator" | "production" | "disabled";
  firestoreRuntimeReady: boolean;
  firestoreLastError: string | null;
}

export interface PlanActionRequest {
  sessionId: string;
  userGoal: string;
  pageUrl?: string;
  pageTitle?: string;
  visibleText: string[];
  elements: UIElementSnapshot[];
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

export interface ActiveTabInfo {
  tabId: number;
  windowId?: number;
  url?: string;
  title?: string;
}

export interface SandboxFixtureContext {
  fixtureId: string;
  seed: number;
  patientName: string;
  patientDob: string;
  loginSecret: string;
  doctorName: string;
  appointmentType: string;
  clinicLabel: string;
  waitingRoomState: string;
  clinicianReadyState: string;
  appointmentTimeText: string;
  visitTitle: string;
  detailsChecklist: string[];
}

export interface SandboxRunStartResponse {
  runId: string;
  seed: number;
  fixture: SandboxFixtureContext;
  startedAt: string;
}

export type BackgroundMessage =
  | { type: "GET_ACTIVE_TAB" }
  | { type: "COLLECT_PAGE_STATE" }
  | { type: "COLLECT_CONTEXT_WITH_SCREENSHOT" }
  | { type: "PING_CONTENT_SCRIPT" }
  | { type: "EXECUTE_ACTION"; action: ActionObject }
  | { type: "HIGHLIGHT"; id: string };

export type BackgroundResponse =
  | { ok: true; tab: ActiveTabInfo }
  | { ok: true; snapshot: PageSnapshot }
  | { ok: true; context: PageContextWithScreenshot }
  | { ok: true; message: string }
  | { ok: false; error: string };

export type ContentScriptMessage =
  | { type: "PING" }
  | { type: "COLLECT_PAGE_STATE" }
  | { type: "HIGHLIGHT"; id: string }
  | { type: "EXECUTE_ACTION"; action: ActionObject };

export type ContentScriptResponse =
  | { ok: true; snapshot: PageSnapshot }
  | { ok: true; message: string }
  | { ok: false; error: string };
