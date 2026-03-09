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

export interface SessionStartRequest {
  userGoal: string;
}

export interface SessionStartResponse {
  sessionId: string;
  createdAt: string;
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
  url?: string;
  title?: string;
}

export type BackgroundMessage =
  | { type: "GET_ACTIVE_TAB" }
  | { type: "COLLECT_PAGE_STATE" }
  | { type: "EXECUTE_ACTION"; action: ActionObject }
  | { type: "HIGHLIGHT"; id: string };

export type BackgroundResponse =
  | { ok: true; tab: ActiveTabInfo }
  | { ok: true; snapshot: PageSnapshot }
  | { ok: true; message: string }
  | { ok: false; error: string };

export type ContentScriptMessage =
  | { type: "COLLECT_PAGE_STATE" }
  | { type: "HIGHLIGHT"; id: string }
  | { type: "EXECUTE_ACTION"; action: ActionObject };

export type ContentScriptResponse =
  | { ok: true; snapshot: PageSnapshot }
  | { ok: true; message: string }
  | { ok: false; error: string };
