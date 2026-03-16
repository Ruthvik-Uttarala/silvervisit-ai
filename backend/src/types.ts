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
  useVertexAI: boolean;
  googleCloudProject: string;
  googleCloudLocation: string;
  geminiActionModel: string;
  geminiLiveModel: string;
  enableLiveApi: boolean;
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

export interface WsLiveReadyMessage {
  type: "live_ready";
  sessionId: string;
  model: string;
}

export type LiveServerMessage =
  | WsErrorMessage
  | WsModelTextMessage
  | WsTranscriptMessage
  | WsPlannedActionMessage
  | WsToolCallMessage
  | WsLiveReadyMessage;

export type AppointmentStatus =
  | "upcoming"
  | "today"
  | "ready_to_join"
  | "waiting_room"
  | "completed"
  | "past"
  | "canceled"
  | "rescheduled";

export type PortalLifecycleState =
  | "pre_check_in"
  | "echeckin_in_progress"
  | "device_setup"
  | "waiting_room"
  | "provider_ready"
  | "joined";

export interface SandboxAppointment {
  appointmentId: string;
  scheduledDateTime: string;
  joinWindowStart: string;
  joinWindowEnd: string;
  status: AppointmentStatus;
  joinableNow: boolean;
  providerName: string;
  specialty: string;
  visitType: string;
  locationLabel: string;
  note?: string;
}

export interface SandboxPreVisitTask {
  taskId: string;
  label: string;
  required: boolean;
  completed: boolean;
  section: string;
}

export interface SandboxDeviceCheck {
  checkId: string;
  label: string;
  required: boolean;
  passed: boolean;
}

export interface SandboxSupportPath {
  pathId: string;
  label: string;
  description: string;
  actionHint: string;
}

export interface SandboxPastVisitSummary {
  visitId: string;
  completedDateTime: string;
  providerName: string;
  specialty: string;
  summaryTitle: string;
  summarySnippet: string;
}

export interface SandboxReportResult {
  resultId: string;
  appointmentId: string;
  createdDateTime: string;
  providerName: string;
  specialty: string;
  topic: string;
  resultType: string;
  status: "final" | "pending";
  summaryTitle: string;
  summarySnippet: string;
}

export interface SandboxNoteAvs {
  noteId: string;
  appointmentId: string;
  completedDateTime: string;
  providerName: string;
  specialty: string;
  topic: string;
  summaryTitle: string;
  summarySnippet: string;
}

export interface SandboxMessageThread {
  threadId: string;
  appointmentId?: string;
  updatedDateTime: string;
  providerName: string;
  specialty: string;
  topic: string;
  subject: string;
  preview: string;
  unreadCount: number;
}

export interface SandboxPrescription {
  prescriptionId: string;
  appointmentId: string;
  createdDateTime: string;
  providerName: string;
  specialty: string;
  topic: string;
  medicationName: string;
  dosage: string;
  status: "active" | "completed" | "stopped";
}

export interface SandboxReferral {
  referralId: string;
  appointmentId: string;
  createdDateTime: string;
  providerName: string;
  specialty: string;
  topic: string;
  referredTo: string;
  referralReason: string;
  status: "open" | "scheduled" | "closed";
}

export type NavigatorDestination =
  | "appointments"
  | "reports_results"
  | "notes_avs"
  | "messages"
  | "prescriptions"
  | "referrals"
  | "help"
  | "unknown";

export type NavigatorActionVerb = "join" | "open" | "show" | "send_message" | "unknown";

export interface ParsedNavigatorIntent {
  destination: NavigatorDestination;
  actionVerb: NavigatorActionVerb;
  patientName?: string;
  dob?: string;
  loginSecret?: string;
  providerName?: string;
  specialty?: string;
  topic?: string;
  explicitDate?: string;
  explicitTime?: string;
  temporalCues: string[];
  rawGoal: string;
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
  portalNow: string;
  portalState: PortalLifecycleState;
  appointments: SandboxAppointment[];
  preVisitTasks: SandboxPreVisitTask[];
  deviceChecks: SandboxDeviceCheck[];
  supportPaths: SandboxSupportPath[];
  pastVisitSummaries: SandboxPastVisitSummary[];
  reportsResults: SandboxReportResult[];
  notesAvs: SandboxNoteAvs[];
  messageThreads: SandboxMessageThread[];
  prescriptions: SandboxPrescription[];
  referrals: SandboxReferral[];
}

export interface SandboxRunStartRequest {
  seed?: number;
  source?: "sandbox" | "extension";
  navigatorSessionId?: string;
}

export interface SandboxRunStartResponse {
  runId: string;
  seed: number;
  fixture: SandboxFixtureContext;
  startedAt: string;
}

export interface SandboxRunEventRequest {
  runId: string;
  step: string;
  eventType: string;
  metadata?: Record<string, unknown>;
}
