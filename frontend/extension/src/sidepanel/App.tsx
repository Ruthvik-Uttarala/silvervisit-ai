import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getBackendBaseUrl,
  getBackendWsUrl,
  getHealth,
  planAction,
  postSandboxRunEvent,
  startSandboxRun,
  startSession,
} from "../lib/api";
import { shouldEmitFeedEntry } from "../lib/feedDeduper";
import {
  buildGoalQueue,
  getActiveGoal,
  GoalItem,
  normalizeGoalFingerprint,
  removeCompletedGoals,
  serializePendingGoals,
  updateGoalStatus,
} from "../lib/goalQueue";
import { LiveAudioRecorder } from "../lib/liveAudio";
import {
  createTurnGenerationToken,
  isTurnGenerationCurrent,
  reconcileSupportState,
  shouldApplyLiveGenerationEvent,
  SupportState,
} from "../lib/runtimeGuards";
import {
  appendTranscriptSegment,
  flushPendingInterim,
  normalizeTranscriptFingerprint,
  toSpeechResultStrings,
} from "../lib/transcriptComposer";
import { buildUnsupportedPageReason, isSupportedTelehealthUrl } from "../lib/telehealthSupport";
import type {
  ActionObject,
  BackgroundMessage,
  BackgroundResponse,
  PageContextWithScreenshot,
  PlanActionResponse,
  SandboxFixtureContext,
} from "../lib/types";
import { sanitizeUserFacingError, toUserFacingError } from "../lib/userFacingError";

const DEFAULT_USER_GOAL = "Help me join my doctor appointment.";
const TURN_COOLDOWN_MS = 900;
const NO_PROGRESS_REPEAT_THRESHOLD = 2;
const NO_PROGRESS_HARD_CAP = 4;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FEED_DEDUPE_WINDOW_MS = 2200;
const LIVE_WARNING_DEDUPE_WINDOW_MS = 6000;

type LiveStatus = "disconnected" | "connecting" | "socket_connected_not_ready" | "live_ready" | "error";
type Tone = "info" | "success" | "warning" | "error";
type SafetyState = "found_destination" | "opened_destination" | "ready_for_next_step" | "waiting_room" | "joined";

interface PlannerState {
  safetyState: SafetyState;
  whatFound: string;
  whatDoingNow: string;
  whatNext: string;
}

const DEFAULT_PLANNER_STATE: PlannerState = {
  safetyState: "ready_for_next_step",
  whatFound: "I am ready to inspect the current telehealth page.",
  whatDoingNow: "Waiting for your instruction.",
  whatNext: "Speak or type your goal, then run one grounded step.",
};

interface FeedEntry {
  tone: Tone;
  text: string;
  time: string;
}

interface LiveEntry {
  kind: "event" | "error" | "model_text" | "transcript";
  text: string;
  time: string;
}

interface ActionHistoryEntry {
  id: string;
  turnId: string;
  status: PlanActionResponse["status"];
  actionType: ActionObject["type"];
  targetId: string;
  groundedIds: string[];
  summary: string;
  outcome?: string;
  timestamp: string;
}

function isJoinGoalText(goal: string): boolean {
  const normalized = goal.toLowerCase();
  return /\b(join|appointment|check ?in|waiting room|visit|enter call)\b/.test(normalized);
}

function hasVisibleGoalCompletionEvidence(goal: string, context: PageContextWithScreenshot, plan: PlanActionResponse): {
  complete: boolean;
  evidence: string;
} {
  const visible = context.snapshot.visibleText.join(" ").toLowerCase();
  if (plan.status === "ok" && plan.action.type === "done") {
    return { complete: true, evidence: "Planner returned done with grounded evidence." };
  }
  if (isJoinGoalText(goal)) {
    if (/\bjoined\b|\byou have joined\b|\bin call\b/.test(visible)) {
      return { complete: true, evidence: "Joined-call evidence is visible on the page." };
    }
    return { complete: false, evidence: "Join goal still in prerequisite state." };
  }
  if (
    /\b(report|result|referral|prescription|message|note|avs|after visit|past visit)\b/.test(goal.toLowerCase()) &&
    /detail|summary|return to related appointment|message thread|linked appointment/i.test(visible)
  ) {
    return { complete: true, evidence: "Requested detail/item evidence is visible." };
  }
  return { complete: false, evidence: "Final goal evidence not visible yet." };
}

function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function trimItems<T>(items: T[], max = 120): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

function normalizeGoalKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);
}

function toneClass(tone: Tone): string {
  if (tone === "success") return "text-emerald-700";
  if (tone === "warning") return "text-amber-700";
  if (tone === "error") return "text-rose-700";
  return "text-slate-700";
}

function canExecuteAction(action: ActionObject): boolean {
  return action.type !== "ask_user" && action.type !== "done";
}

function describeAction(action: ActionObject): string {
  const parts: string[] = [action.type];
  if (action.targetId) parts.push(`target=${action.targetId}`);
  if (action.value) parts.push(`value=\"${action.value}\"`);
  return parts.join(" ");
}

function extractSeedFromUrl(url?: string): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const seedRaw = parsed.searchParams.get("seed");
    const seed = Number(seedRaw);
    if (!Number.isFinite(seed) || seed <= 0) return undefined;
    return Math.floor(seed);
  } catch {
    return undefined;
  }
}

function sanitizeImagePayload(mimeType: string, base64: string): string {
  const normalizedMime = mimeType.trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(normalizedMime)) {
    throw new Error(`Unsupported screenshot mime type: ${mimeType}`);
  }
  return base64.trim().replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
}

function buildSnapshotSignature(context: PageContextWithScreenshot): string {
  const textSignature = context.snapshot.visibleText.slice(0, 20).join("|").slice(0, 1200);
  const elementSignature = context.snapshot.elements
    .slice(0, 35)
    .map((item) => `${item.id}:${item.text}`)
    .join("|")
    .slice(0, 1400);
  return `${context.snapshot.pageUrl}|${textSignature}|${elementSignature}`;
}

function inferSafetyState(
  context: PageContextWithScreenshot,
  fallback: SafetyState = "ready_for_next_step",
): SafetyState {
  const lines = context.snapshot.visibleText.join(" ").toLowerCase();
  if (/\bjoined\b|\byou have joined\b|\bin call\b/.test(lines)) {
    return "joined";
  }
  if (/\bwaiting room\b/.test(lines)) {
    return "waiting_room";
  }
  return fallback;
}

async function sendBackgroundMessage<T extends BackgroundResponse>(message: BackgroundMessage): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as T;
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response;
}

export default function App() {
  const [userGoal, setUserGoal] = useState(DEFAULT_USER_GOAL);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [latestPlan, setLatestPlan] = useState<PlanActionResponse | null>(null);
  const [isRunningTurn, setIsRunningTurn] = useState(false);
  const [isMicListening, setIsMicListening] = useState(false);
  const [feed, setFeed] = useState<FeedEntry[]>([
    { tone: "info", text: "Speak or type a goal, then run one grounded step.", time: nowLabel() },
  ]);
  const [liveEntries, setLiveEntries] = useState<LiveEntry[]>([]);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("disconnected");
  const [supportState, setSupportState] = useState<SupportState>({
    status: "unknown",
    activeUrl: undefined,
    reason: undefined,
    generation: 0,
  });
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeFixture, setActiveFixture] = useState<SandboxFixtureContext | null>(null);
  const [clickExecutions, setClickExecutions] = useState(0);
  const [typeExecutions, setTypeExecutions] = useState(0);
  const [latestTurnId, setLatestTurnId] = useState<string | null>(null);
  const [plannerState, setPlannerState] = useState<PlannerState>(DEFAULT_PLANNER_STATE);
  const [actionHistory, setActionHistory] = useState<ActionHistoryEntry[]>([]);
  const [goalQueue, setGoalQueue] = useState<GoalItem[]>(() => buildGoalQueue(DEFAULT_USER_GOAL));

  const turnLockRef = useRef(false);
  const lastTurnAtRef = useRef(0);
  const capturePromiseRef = useRef<Promise<PageContextWithScreenshot> | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const liveStatusRef = useRef<LiveStatus>("disconnected");
  const liveConnectionIdRef = useRef(0);
  const sentLiveMessageIdsRef = useRef<Set<string>>(new Set());
  const liveAudioRecorderRef = useRef<LiveAudioRecorder | null>(null);
  const isMicListeningRef = useRef(false);
  const composerTextRef = useRef(DEFAULT_USER_GOAL);
  const micCommittedSegmentsRef = useRef<string[]>([]);
  const micInterimSegmentRef = useRef("");
  const liveUserSegmentsRef = useRef<string[]>([]);
  const recentTranscriptFingerprintsRef = useRef<Array<{ key: string; at: number }>>([]);
  const feedDeduperRef = useRef({ key: "", at: 0 });
  const liveWarningDeduperRef = useRef<Record<string, number>>({});
  const speechRef = useRef<any>(null);
  const speechShouldContinueRef = useRef(false);
  const micTurnIdRef = useRef("");
  const liveTurnSendGuardRef = useRef<Set<string>>(new Set());
  const audioChunkEvidenceRef = useRef<{ turnId: string; firstChunkSeen: boolean }>({ turnId: "", firstChunkSeen: false });
  const scrollGuardRef = useRef<{ signature: string; direction: string; repeats: number }>({
    signature: "",
    direction: "down",
    repeats: 0,
  });
  const noProgressBudgetRef = useRef<{
    goalKey: string;
    totalNoProgress: number;
    samePatternRepeats: number;
    lastPattern: string;
    lastSignature: string;
  }>({
    goalKey: "",
    totalNoProgress: 0,
    samePatternRepeats: 0,
    lastPattern: "",
    lastSignature: "",
  });
  const tabGenerationRef = useRef(0);
  const snapshotGenerationRef = useRef(0);
  const activeTabUrlRef = useRef("");
  const liveGenerationRef = useRef(0);
  const liveReadyGenerationRef = useRef(0);
  const dispatchedGoalFingerprintRef = useRef("");
  const goalQueueDirtyRef = useRef(true);
  const goalQueueRef = useRef<GoalItem[]>(buildGoalQueue(DEFAULT_USER_GOAL));

  const setComposerText = useCallback((next: string) => {
    const sanitized = next.slice(0, 1000);
    composerTextRef.current = sanitized;
    setUserGoal(sanitized);
    goalQueueDirtyRef.current = true;
  }, []);

  const appendToComposer = useCallback(
    (segment: string) => {
      const merged = appendTranscriptSegment(composerTextRef.current, segment);
      if (merged !== composerTextRef.current) {
        setComposerText(merged);
      }
    },
    [setComposerText],
  );

  const applyGoalQueue = useCallback(
    (nextGoals: GoalItem[], options?: { syncComposer?: boolean }) => {
      goalQueueRef.current = nextGoals;
      setGoalQueue(nextGoals);
      if (options?.syncComposer) {
        const serialized = serializePendingGoals(nextGoals);
        composerTextRef.current = serialized;
        setUserGoal(serialized);
      }
    },
    [],
  );

  const ensureGoalQueue = useCallback((): GoalItem[] => {
    if (!goalQueueDirtyRef.current && goalQueueRef.current.length > 0) {
      return goalQueueRef.current;
    }
    const fromComposer = buildGoalQueue(composerTextRef.current);
    goalQueueDirtyRef.current = false;
    goalQueueRef.current = fromComposer;
    setGoalQueue(fromComposer);
    return fromComposer;
  }, []);

  const pushFeed = useCallback((tone: Tone, text: string, options?: { dedupeKey?: string; dedupeMs?: number }) => {
    const normalizedText = sanitizeUserFacingError(text, text).slice(0, 260);
    const key = `${tone}:${options?.dedupeKey ?? normalizedText}`;
    const now = Date.now();
    const decision = shouldEmitFeedEntry(
      feedDeduperRef.current,
      key,
      now,
      options?.dedupeMs ?? FEED_DEDUPE_WINDOW_MS,
    );
    feedDeduperRef.current = decision.next;
    if (!decision.emit) {
      return;
    }
    setFeed((prev) => trimItems([...prev, { tone, text: normalizedText, time: nowLabel() }]));
  }, []);

  const pushHistory = useCallback((entry: ActionHistoryEntry) => {
    setActionHistory((prev) => trimItems([...prev, entry], 80));
  }, []);

  const updateHistoryOutcome = useCallback((id: string, outcome: string) => {
    setActionHistory((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, outcome } : entry)),
    );
  }, []);

  const pushLive = useCallback((entry: LiveEntry) => {
    setLiveEntries((prev) => trimItems([...prev, entry], 200));
  }, []);

  const patchPlannerState = useCallback((patch: Partial<PlannerState>) => {
    setPlannerState((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetPlannerState = useCallback(() => {
    setPlannerState(DEFAULT_PLANNER_STATE);
    setLatestPlan(null);
  }, []);

  const applySupportTransition = useCallback((nextStatus: SupportState["status"], url?: string, reason?: string) => {
    let becameSupported = false;
    let becameUnsupported = false;
    setSupportState((previous) => {
      const transition = reconcileSupportState(previous, nextStatus, url, reason);
      if (!transition.changed) {
        return previous;
      }
      tabGenerationRef.current = transition.next.generation;
      activeTabUrlRef.current = transition.next.activeUrl ?? "";
      snapshotGenerationRef.current += 1;
      becameSupported = transition.becameSupported;
      becameUnsupported = transition.becameUnsupported;
      return transition.next;
    });
    if (becameSupported) {
      resetPlannerState();
    }
    if (becameUnsupported) {
      setLatestPlan(null);
    }
  }, [resetPlannerState]);

  const rememberTranscriptFingerprint = useCallback((segment: string): boolean => {
    const key = normalizeTranscriptFingerprint(segment);
    if (!key) {
      return false;
    }
    const now = Date.now();
    const retained = recentTranscriptFingerprintsRef.current.filter((item) => now - item.at < 12000);
    const exists = retained.some((item) => item.key === key);
    if (!exists) {
      retained.push({ key, at: now });
    }
    recentTranscriptFingerprintsRef.current = retained;
    return exists;
  }, []);

  const appendMicSegment = useCallback(
    (segment: string) => {
      const normalizedSegment = normalizeGoalKey(segment);
      if (
        dispatchedGoalFingerprintRef.current &&
        composerTextRef.current.trim().length === 0 &&
        (dispatchedGoalFingerprintRef.current === normalizedSegment ||
          dispatchedGoalFingerprintRef.current.endsWith(normalizedSegment))
      ) {
        return;
      }
      if (!segment || rememberTranscriptFingerprint(segment)) {
        return;
      }
      micCommittedSegmentsRef.current.push(segment);
      appendToComposer(segment);
    },
    [appendToComposer, rememberTranscriptFingerprint],
  );

  const flushMicInterimToComposer = useCallback(() => {
    const pending = micInterimSegmentRef.current;
    if (!pending) {
      return;
    }
    const merged = flushPendingInterim(composerTextRef.current, pending);
    micInterimSegmentRef.current = "";
    if (merged !== composerTextRef.current) {
      setComposerText(merged);
    }
  }, [setComposerText]);

  const setAuthoritativeLiveStatus = useCallback((status: LiveStatus) => {
    liveStatusRef.current = status;
    setLiveStatus(status);
  }, []);

  const ensureSession = useCallback(
    async (goal: string): Promise<string> => {
      if (sessionId) return sessionId;
      const started = await startSession({ userGoal: goal });
      setSessionId(started.sessionId);
      return started.sessionId;
    },
    [sessionId],
  );

  const checkPageSupport = useCallback(async (): Promise<{ ok: boolean; url?: string }> => {
    try {
      const tab = await sendBackgroundMessage<{ ok: true; tab: { url?: string; tabId: number } }>({ type: "GET_ACTIVE_TAB" });
      if (!isSupportedTelehealthUrl(tab.tab.url)) {
        const shownUrl = tab.tab.url?.trim() || "unknown URL";
        const reason = buildUnsupportedPageReason(tab.tab.url);
        applySupportTransition("unsupported", tab.tab.url, reason);
        patchPlannerState({
          whatFound: `You're currently on a non-telehealth page (${shownUrl}).`,
          whatDoingNow: "Paused to prevent unsafe actions on this page.",
          whatNext: "Please return to the SilverVisit telehealth tab and I'll continue your goal.",
        });
        return { ok: false, url: tab.tab.url };
      }
      applySupportTransition("supported", tab.tab.url);
      return { ok: true, url: tab.tab.url };
    } catch (error) {
      const message = toUserFacingError(error, "Unable to detect the active tab.");
      applySupportTransition("unsupported", undefined, message);
      patchPlannerState({
        whatFound: "Unable to verify the active telehealth tab.",
        whatDoingNow: "Paused until tab state can be confirmed.",
        whatNext: "Focus the telehealth sandbox tab and retry.",
      });
      return { ok: false };
    }
  }, [applySupportTransition, patchPlannerState]);

  const collectContextWithScreenshot = useCallback(async (): Promise<PageContextWithScreenshot> => {
    if (capturePromiseRef.current) return capturePromiseRef.current;
    const promise = (async () => {
      const response = await sendBackgroundMessage<{ ok: true; context: PageContextWithScreenshot }>({
        type: "COLLECT_CONTEXT_WITH_SCREENSHOT",
      });
      response.context.screenshot.base64 = sanitizeImagePayload(
        response.context.screenshot.mimeType,
        response.context.screenshot.base64,
      );
      return response.context;
    })();
    capturePromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      capturePromiseRef.current = null;
    }
  }, []);

  const sendLiveMessage = useCallback((payload: Record<string, unknown>): boolean => {
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const messageId = (payload.messageId as string | undefined) ?? crypto.randomUUID();
    if (sentLiveMessageIdsRef.current.has(messageId)) return false;
    sentLiveMessageIdsRef.current.add(messageId);
    if (sentLiveMessageIdsRef.current.size > 500) {
      const first = sentLiveMessageIdsRef.current.values().next().value as string | undefined;
      if (first) sentLiveMessageIdsRef.current.delete(first);
    }
    socket.send(JSON.stringify({ ...payload, messageId }));
    return true;
  }, []);

  const connectLive = useCallback(async (goal: string, sid: string) => {
    if (liveStatusRef.current === "connecting" || liveStatusRef.current === "socket_connected_not_ready" || liveStatusRef.current === "live_ready") return;
    const existingSocket = liveSocketRef.current;
    if (existingSocket && existingSocket.readyState === WebSocket.OPEN) {
      try {
        existingSocket.close();
      } catch {
        // best effort close before reopening
      }
    }
    const liveGeneration = liveGenerationRef.current + 1;
    liveGenerationRef.current = liveGeneration;
    liveReadyGenerationRef.current = 0;
    setAuthoritativeLiveStatus("connecting");
    pushFeed("info", "Mic starting. Connecting to Gemini Live...");
    const connectionId = liveConnectionIdRef.current + 1;
    liveConnectionIdRef.current = connectionId;
    const socket = new WebSocket(`${getBackendWsUrl()}/api/live`);
    liveSocketRef.current = socket;
    sentLiveMessageIdsRef.current.clear();
    socket.onopen = () => {
      if (
        liveConnectionIdRef.current !== connectionId ||
        liveSocketRef.current !== socket ||
        !shouldApplyLiveGenerationEvent(liveGeneration, liveGenerationRef.current)
      ) return;
      setAuthoritativeLiveStatus("socket_connected_not_ready");
      sendLiveMessage({ type: "start", userGoal: goal, sessionId: sid });
      pushLive({ kind: "event", text: "Live socket connected.", time: nowLabel() });
      pushFeed("info", "Live socket connected. Waiting for live_ready...");
    };
    socket.onmessage = (event) => {
      if (
        liveConnectionIdRef.current !== connectionId ||
        liveSocketRef.current !== socket ||
        !shouldApplyLiveGenerationEvent(liveGeneration, liveGenerationRef.current)
      ) return;
      let parsed: any;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        pushFeed("warning", "Received an unexpected live event payload.", {
          dedupeKey: "live-unexpected-payload",
          dedupeMs: 5000,
        });
        return;
      }
      if (parsed.type === "live_ready") {
        liveReadyGenerationRef.current = liveGeneration;
        setAuthoritativeLiveStatus("live_ready");
        pushLive({ kind: "event", text: "live_ready received.", time: nowLabel() });
        liveWarningDeduperRef.current = {};
        pushFeed("success", "Live is ready for text, image, and audio.");
      } else if (parsed.type === "error") {
        setAuthoritativeLiveStatus("error");
        const errorText = sanitizeUserFacingError(`${parsed.code ?? "live_error"}: ${parsed.message ?? "Unknown live error"}`);
        pushLive({ kind: "error", text: errorText, time: nowLabel() });
        pushFeed("error", errorText, { dedupeKey: `live-error-${errorText}`, dedupeMs: 4000 });
      } else if (parsed.type === "model_text") {
        const modelText = typeof parsed.text === "string" ? parsed.text.trim() : "";
        if (modelText) {
          pushLive({ kind: "model_text", text: modelText, time: nowLabel() });
        }
      } else if (parsed.type === "transcript") {
        const transcriptText = typeof parsed.text === "string" ? parsed.text.trim() : "";
        const role = typeof parsed.role === "string" ? parsed.role : "system";
        if (transcriptText) {
          pushLive({ kind: "transcript", text: `${role}: ${transcriptText}`, time: nowLabel() });
          pushFeed("info", `Transcript received (${role}).`, {
            dedupeKey: `live-transcript-${role}`,
            dedupeMs: 2000,
          });
        }
        if (isMicListeningRef.current && role === "user" && transcriptText) {
          if (!rememberTranscriptFingerprint(transcriptText)) {
            liveUserSegmentsRef.current.push(transcriptText);
            appendToComposer(transcriptText);
          }
        }
      }
    };
    socket.onclose = () => {
      if (
        liveConnectionIdRef.current !== connectionId ||
        !shouldApplyLiveGenerationEvent(liveGeneration, liveGenerationRef.current)
      ) return;
      liveReadyGenerationRef.current = 0;
      if (liveStatusRef.current !== "error") {
        setAuthoritativeLiveStatus("disconnected");
      }
    };
    socket.onerror = () => {
      if (!shouldApplyLiveGenerationEvent(liveGeneration, liveGenerationRef.current)) {
        return;
      }
      liveReadyGenerationRef.current = 0;
      setAuthoritativeLiveStatus("error");
      pushFeed("error", "Live connection error. Please retry.", {
        dedupeKey: "live-connection-error",
        dedupeMs: 5000,
      });
    };
  }, [appendToComposer, pushFeed, pushLive, rememberTranscriptFingerprint, sendLiveMessage, setAuthoritativeLiveStatus]);

  const waitForLiveReady = useCallback(async (timeoutMs = 12000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (liveStatusRef.current === "live_ready") return true;
      if (liveStatusRef.current === "error") return false;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }, []);

  const stopSpeech = useCallback(() => {
    speechShouldContinueRef.current = false;
    const speech = speechRef.current;
    speechRef.current = null;
    if (!speech) return;
    try {
      speech.stop();
    } catch {
      speech.abort();
    }
  }, []);

  const stopMic = useCallback(async () => {
    stopSpeech();
    flushMicInterimToComposer();
    const recorder = liveAudioRecorderRef.current;
    liveAudioRecorderRef.current = null;
    if (recorder) {
      await recorder.stop().catch(() => undefined);
    }
    setIsMicListening(false);
    isMicListeningRef.current = false;
    const turnId = micTurnIdRef.current;
    const canSendAudioEnd =
      Boolean(turnId) &&
      liveSocketRef.current?.readyState === WebSocket.OPEN &&
      liveStatusRef.current === "live_ready" &&
      liveReadyGenerationRef.current === liveGenerationRef.current;
    if (canSendAudioEnd) {
      sendLiveMessage({ type: "user_audio_chunk", turnId, audioStreamEnd: true });
      pushFeed("info", "Audio stream ended.");
      micTurnIdRef.current = "";
    }
    micCommittedSegmentsRef.current = [];
    micInterimSegmentRef.current = "";
    liveUserSegmentsRef.current = [];
    recentTranscriptFingerprintsRef.current = [];
  }, [flushMicInterimToComposer, pushFeed, sendLiveMessage, stopSpeech]);

  const startMic = useCallback(async () => {
    if (isMicListening) {
      await stopMic();
      return;
    }
    try {
      const support = await checkPageSupport();
      if (!support.ok) {
        return;
      }
      pushFeed("info", "Mic starting...");
      dispatchedGoalFingerprintRef.current = "";
      const goal = composerTextRef.current.trim() || DEFAULT_USER_GOAL;
      const sid = await ensureSession(goal);
      const liveSocketOpen = liveSocketRef.current?.readyState === WebSocket.OPEN;
      if (!liveSocketOpen && liveStatusRef.current !== "disconnected") {
        liveReadyGenerationRef.current = 0;
        setAuthoritativeLiveStatus("disconnected");
      }
      if (liveStatusRef.current !== "live_ready") {
        await connectLive(goal, sid);
        const ready = await waitForLiveReady();
        if (!ready) {
          pushFeed("error", "Live not ready. Wait for live_ready and try again.", {
            dedupeKey: "live-not-ready-mic-start",
            dedupeMs: 4000,
          });
          return;
        }
      }
      micCommittedSegmentsRef.current = [];
      micInterimSegmentRef.current = "";
      liveUserSegmentsRef.current = [];
      recentTranscriptFingerprintsRef.current = [];
      speechShouldContinueRef.current = true;

    const beginSpeechRecognition = () => {
      const SpeechCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechCtor) {
        return;
      }
      const speech = new SpeechCtor();
      speech.continuous = true;
      speech.interimResults = true;
      speech.lang = "en-US";
      speech.onresult = (event: any) => {
        const entries: Array<{ transcript: string; isFinal: boolean }> = [];
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const transcript = String(event.results[i][0]?.transcript ?? "");
          if (!transcript) {
            continue;
          }
          entries.push({ transcript, isFinal: Boolean(event.results[i].isFinal) });
        }
        const extracted = toSpeechResultStrings(entries);
        if (extracted.finalText) {
          appendMicSegment(extracted.finalText);
        }
        micInterimSegmentRef.current = extracted.interimText;
      };
      speech.onerror = (event: { error?: string }) => {
        const reason = sanitizeUserFacingError(event.error ?? "speech recognition error");
        pushFeed("warning", `Speech recognition issue: ${reason}`, {
          dedupeKey: `speech-error-${reason}`,
          dedupeMs: 5000,
        });
      };
      speech.onend = () => {
        flushMicInterimToComposer();
        if (!speechShouldContinueRef.current || !isMicListeningRef.current) {
          return;
        }
        setTimeout(() => {
          if (!speechShouldContinueRef.current || !isMicListeningRef.current) {
            return;
          }
          beginSpeechRecognition();
        }, 200);
      };
      speechRef.current = speech;
      try {
        speech.start();
      } catch (error) {
        pushFeed("warning", `Speech recognition unavailable: ${toUserFacingError(error)}`, {
          dedupeKey: "speech-start-failed",
          dedupeMs: 6000,
        });
        speechRef.current = null;
      }
    };

      const SpeechCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechCtor) {
        beginSpeechRecognition();
      } else {
        pushFeed("warning", "Browser speech recognition is unavailable. Live transcript will still update your goal.", {
          dedupeKey: "speech-unavailable",
          dedupeMs: 8000,
        });
      }
      micTurnIdRef.current = crypto.randomUUID();
      audioChunkEvidenceRef.current = { turnId: micTurnIdRef.current, firstChunkSeen: false };
      liveWarningDeduperRef.current.liveNotReadyAudio = 0;
      const recorder = new LiveAudioRecorder({
        onPermissionGranted: () => pushFeed("success", "Microphone permission granted."),
        onPermissionDenied: (message) =>
          pushFeed("error", `Microphone permission denied: ${sanitizeUserFacingError(message)}`),
        onStart: () => {
          setIsMicListening(true);
          isMicListeningRef.current = true;
          pushFeed("info", "Listening...");
        },
        onChunk: (payload) => {
          const liveReadyCurrent =
            liveStatusRef.current === "live_ready" &&
            liveSocketRef.current?.readyState === WebSocket.OPEN &&
            liveReadyGenerationRef.current === liveGenerationRef.current;
          if (!liveReadyCurrent) {
            const now = Date.now();
            const last = liveWarningDeduperRef.current.liveNotReadyAudio ?? 0;
            if (now - last >= LIVE_WARNING_DEDUPE_WINDOW_MS) {
              pushFeed("warning", "Live not ready yet. Holding audio until ready.", {
                dedupeKey: "live-not-ready-audio",
                dedupeMs: LIVE_WARNING_DEDUPE_WINDOW_MS,
              });
              liveWarningDeduperRef.current.liveNotReadyAudio = now;
            }
            return;
          }
          if (
            audioChunkEvidenceRef.current.turnId === micTurnIdRef.current &&
            audioChunkEvidenceRef.current.firstChunkSeen === false
          ) {
            audioChunkEvidenceRef.current.firstChunkSeen = true;
            pushFeed("info", "Audio streaming started.");
          }
          sendLiveMessage({
            type: "user_audio_chunk",
            turnId: micTurnIdRef.current,
            mimeType: payload.mimeType,
            dataBase64: payload.dataBase64,
          });
        },
        onError: (message) => pushFeed("error", `Mic pipeline error: ${sanitizeUserFacingError(message)}`),
        onStop: () => {
          flushMicInterimToComposer();
          setIsMicListening(false);
          isMicListeningRef.current = false;
        },
      });
      liveAudioRecorderRef.current = recorder;
      await recorder.start();
    } catch (error) {
      pushFeed("error", `Unable to start microphone: ${toUserFacingError(error)}`);
      await stopMic();
    }
  }, [
    appendMicSegment,
    checkPageSupport,
    connectLive,
    ensureSession,
    flushMicInterimToComposer,
    isMicListening,
    pushFeed,
    sendLiveMessage,
    stopMic,
    waitForLiveReady,
  ]);

  const runPrimaryTurn = useCallback(async () => {
    if (turnLockRef.current || isRunningTurn) return;
    flushMicInterimToComposer();
    const parsedQueue = ensureGoalQueue();
    const activeGoal = getActiveGoal(parsedQueue);
    if (!activeGoal) {
      pushFeed("warning", "Enter a goal before running.");
      return;
    }
    const goal = activeGoal.text;
    const now = Date.now();
    if (now - lastTurnAtRef.current < TURN_COOLDOWN_MS) {
      pushFeed("warning", "Please wait before running another step.");
      return;
    }
    lastTurnAtRef.current = now;
    turnLockRef.current = true;
    setIsRunningTurn(true);
    const turnId = crypto.randomUUID();
    setLatestTurnId(turnId);
    patchPlannerState({
      whatDoingNow: "Reviewing the current screen and preparing one safe action.",
      whatNext: "Please wait while I validate the next grounded step.",
    });
    let dispatchCommitted = false;
    let turnContext: PageContextWithScreenshot | null = null;

    try {
      await getHealth();
      const support = await checkPageSupport();
      if (!support.ok) return;

      snapshotGenerationRef.current += 1;
      const turnToken = createTurnGenerationToken({
        tabGeneration: tabGenerationRef.current,
        snapshotGeneration: snapshotGenerationRef.current,
        tabUrl: activeTabUrlRef.current,
      });
      const isTurnCurrent = () =>
        isTurnGenerationCurrent(turnToken, {
          tabGeneration: tabGenerationRef.current,
          snapshotGeneration: snapshotGenerationRef.current,
          tabUrl: activeTabUrlRef.current,
        });

      const sid = await ensureSession(goal);
      const run = await startSandboxRun({ seed: extractSeedFromUrl(support.url), source: "extension", navigatorSessionId: sid });
      if (!isTurnCurrent()) {
        pushFeed("info", "Ignored stale planner turn after tab/context changed.", {
          dedupeKey: "stale-turn-ignored",
          dedupeMs: 4000,
        });
        return;
      }
      setActiveRunId(run.runId);
      setActiveFixture(run.fixture);
      const context = await collectContextWithScreenshot();
      turnContext = context;
      applySupportTransition("supported", context.tab.url);
      if (!isTurnCurrent()) {
        pushFeed("info", "Skipped stale snapshot after tab change.", {
          dedupeKey: "stale-snapshot-ignored",
          dedupeMs: 4000,
        });
        return;
      }
      const safetyFromScreen = inferSafetyState(context);
      patchPlannerState({
        safetyState: safetyFromScreen,
        whatFound:
          safetyFromScreen === "waiting_room"
            ? "You are in the waiting room, but not joined yet."
            : safetyFromScreen === "joined"
              ? "I found evidence that you are joined to the visit."
              : "I found the current telehealth page and grounded controls.",
      });

      const liveReadyAndCurrent =
        liveStatusRef.current === "live_ready" &&
        liveReadyGenerationRef.current > 0 &&
        liveReadyGenerationRef.current === liveGenerationRef.current;
      if (liveReadyAndCurrent) {
        const textKey = `${turnId}:user_text`;
        if (!liveTurnSendGuardRef.current.has(textKey)) {
          liveTurnSendGuardRef.current.add(textKey);
          if (liveTurnSendGuardRef.current.size > 200) {
            const first = liveTurnSendGuardRef.current.values().next().value as string | undefined;
            if (first) liveTurnSendGuardRef.current.delete(first);
          }
          sendLiveMessage({ type: "user_text", turnId, text: goal });
        }
        const imageKey = `${turnId}:user_image_frame`;
        if (!liveTurnSendGuardRef.current.has(imageKey)) {
          liveTurnSendGuardRef.current.add(imageKey);
          if (liveTurnSendGuardRef.current.size > 200) {
            const first = liveTurnSendGuardRef.current.values().next().value as string | undefined;
            if (first) liveTurnSendGuardRef.current.delete(first);
          }
          sendLiveMessage({
            type: "user_image_frame",
            turnId,
            mimeType: context.screenshot.mimeType,
            dataBase64: context.screenshot.base64,
          });
        }
      } else if (liveStatusRef.current !== "disconnected") {
        pushFeed("warning", "Live is not ready yet. This turn will run planner-only.");
      }

      dispatchedGoalFingerprintRef.current = normalizeGoalKey(goal);
      dispatchCommitted = true;
      applyGoalQueue(updateGoalStatus(goalQueueRef.current, activeGoal.id, "in_progress"));

      const plan = await planAction({
        sessionId: sid,
        userGoal: goal,
        pageUrl: context.snapshot.pageUrl || context.tab.url,
        pageTitle: context.snapshot.pageTitle || context.tab.title,
        visibleText: context.snapshot.visibleText,
        elements: context.snapshot.elements,
        requireScreenshot: true,
        screenshotMimeType: context.screenshot.mimeType,
        screenshotBase64: context.screenshot.base64,
        sandboxFixture: run.fixture,
      });
      if (!isTurnCurrent()) {
        pushFeed("info", "Discarded late planner response from previous tab snapshot.", {
          dedupeKey: "late-planner-response-discarded",
          dedupeMs: 5000,
        });
        return;
      }

      setLatestPlan(plan);
      patchPlannerState({
        whatFound: plan.action.targetId
          ? `I found grounded target ${plan.action.targetId}.`
          : "I found the current page state but need clarification for a safe target.",
        whatNext: plan.message,
      });
      const fallbackUsed = /\bclosest\b|\bexact\b.*\bnot found\b|\bnot available\b|couldn't find an exact match/i.test(plan.message);
      if (fallbackUsed) {
        applyGoalQueue(updateGoalStatus(goalQueueRef.current, activeGoal.id, "fallback_used", { fallbackUsed: true }));
      }
      pushFeed(
        plan.status === "ok" ? "success" : plan.status === "need_clarification" ? "warning" : "error",
        `${plan.status}: ${describeAction(plan.action)} (turn ${turnId.slice(0, 8)})`,
      );
      const historyId = crypto.randomUUID();
      pushHistory({
        id: historyId,
        turnId,
        status: plan.status,
        actionType: plan.action.type,
        targetId: plan.action.targetId ?? "none",
        groundedIds: plan.grounding.matchedElementIds,
        summary: plan.message,
        timestamp: nowLabel(),
      });
      if (plan.status === "ok" && plan.action.type === "done" && turnContext) {
        const completion = hasVisibleGoalCompletionEvidence(goal, turnContext, plan);
        if (completion.complete) {
          const completedQueue = updateGoalStatus(goalQueueRef.current, activeGoal.id, "completed", {
            completionEvidence: completion.evidence,
            fallbackUsed,
          });
          const remaining = removeCompletedGoals(completedQueue);
          applyGoalQueue(remaining, { syncComposer: true });
          goalQueueDirtyRef.current = false;
          pushFeed(
            "success",
            remaining.length > 0
              ? `Goal complete: "${goal}". Continuing with the next pending goal.`
              : `Goal complete: "${goal}".`,
            { dedupeKey: `goal-complete-${activeGoal.fingerprint}`, dedupeMs: 2000 },
          );
        }
      }

      const goalKey = normalizeGoalKey(goal);
      const snapshotSignature = buildSnapshotSignature(context);
      const actionPattern = `${plan.action.type}:${plan.action.targetId ?? ""}:${plan.action.direction ?? ""}`;
      if (noProgressBudgetRef.current.goalKey !== goalKey) {
        noProgressBudgetRef.current = {
          goalKey,
          totalNoProgress: 0,
          samePatternRepeats: 0,
          lastPattern: "",
          lastSignature: "",
        };
      }
      const noProgressAction = plan.action.type === "scroll" || plan.action.type === "wait" || plan.action.type === "ask_user";
      const sameEvidence = noProgressBudgetRef.current.lastSignature === snapshotSignature;
      const samePattern = noProgressBudgetRef.current.lastPattern === actionPattern;
      if (noProgressAction && sameEvidence) {
        noProgressBudgetRef.current.totalNoProgress += 1;
        noProgressBudgetRef.current.samePatternRepeats = samePattern
          ? noProgressBudgetRef.current.samePatternRepeats + 1
          : 1;
      } else if (!sameEvidence) {
        noProgressBudgetRef.current.totalNoProgress = 0;
        noProgressBudgetRef.current.samePatternRepeats = 0;
      }
      noProgressBudgetRef.current.lastPattern = actionPattern;
      noProgressBudgetRef.current.lastSignature = snapshotSignature;

      if (
        noProgressBudgetRef.current.samePatternRepeats >= NO_PROGRESS_REPEAT_THRESHOLD ||
        noProgressBudgetRef.current.totalNoProgress >= NO_PROGRESS_HARD_CAP
      ) {
        const budgetMessage =
          "I could not make progress after repeated safe retries, so I need your clarification before continuing.";
        setLatestPlan({
          ...plan,
          status: "need_clarification",
          action: { type: "ask_user" },
          message: budgetMessage,
          confidence: Math.min(plan.confidence, 0.3),
        });
        patchPlannerState({
          whatDoingNow: "Stopping repeated retries to stay safe.",
          whatNext: "Please tell me which item to choose next.",
        });
        pushFeed("warning", budgetMessage);
        updateHistoryOutcome(historyId, "Escalated to clarification due to repeated no-progress turns.");
        await postSandboxRunEvent({
          runId: run.runId,
          step: "extension_turn",
          eventType: "no_progress_escalation",
          metadata: { turnId, totalNoProgress: noProgressBudgetRef.current.totalNoProgress },
        }).catch(() => undefined);
        return;
      }

      if (plan.status === "ok" && canExecuteAction(plan.action)) {
        patchPlannerState({
          whatDoingNow: plan.action.targetId
            ? `Executing ${plan.action.type} on grounded target ${plan.action.targetId}.`
            : `Executing ${plan.action.type} as the next grounded step.`,
        });
        if (plan.action.type === "scroll") {
          const direction = plan.action.direction ?? "down";
          if (
            scrollGuardRef.current.signature === snapshotSignature &&
            scrollGuardRef.current.direction === direction
          ) {
            scrollGuardRef.current.repeats += 1;
          } else {
            scrollGuardRef.current = {
              signature: snapshotSignature,
              direction,
              repeats: 0,
            };
          }
          if (scrollGuardRef.current.repeats >= 2) {
            const guardedPlan: PlanActionResponse = {
              ...plan,
              status: "need_clarification",
              message: "Page evidence did not change after repeated scroll attempts. Clarification is needed.",
              action: { type: "ask_user" },
              confidence: Math.min(plan.confidence, 0.3),
            };
            setLatestPlan(guardedPlan);
            pushFeed("warning", "Scroll guard stopped repeated unchanged scrolling. Ask for clarification.");
            patchPlannerState({
              whatDoingNow: "Stopping repeated scrolling to avoid loops.",
              whatNext: "Please clarify what to look for next on the page.",
            });
            updateHistoryOutcome(historyId, "Scroll guard blocked repeated unchanged evidence.");
            await postSandboxRunEvent({
              runId: run.runId,
              step: "extension_turn",
              eventType: "scroll_guard_blocked",
              metadata: { turnId, direction },
            }).catch(() => undefined);
            return;
          }
        } else {
          scrollGuardRef.current = { signature: "", direction: "down", repeats: 0 };
        }

        const response = await sendBackgroundMessage<{ ok: true; message: string }>({
          type: plan.action.type === "highlight" && plan.action.targetId ? "HIGHLIGHT" : "EXECUTE_ACTION",
          expectedTabId: context.tab.tabId,
          expectedUrl: context.tab.url,
          ...(plan.action.type === "highlight" && plan.action.targetId ? { id: plan.action.targetId } : { action: plan.action }),
        } as BackgroundMessage);
        pushFeed("success", response.message);
        updateHistoryOutcome(historyId, response.message);
        if (safetyFromScreen === "waiting_room") {
          patchPlannerState({
            safetyState: "waiting_room",
            whatNext: "You are still in the waiting room. Continue only when provider is ready.",
          });
        } else if (safetyFromScreen === "joined") {
          patchPlannerState({
            safetyState: "joined",
            whatNext: "You are joined. You can now continue with visit tasks if needed.",
          });
        } else {
          patchPlannerState({
            safetyState: plan.action.type === "highlight" ? "found_destination" : "opened_destination",
            whatNext: "Ready for the next safe grounded step.",
          });
        }
        if (plan.action.type === "click") setClickExecutions((v) => v + 1);
        if (plan.action.type === "type") setTypeExecutions((v) => v + 1);
        const completion = hasVisibleGoalCompletionEvidence(goal, context, plan);
        if (completion.complete) {
          const completedQueue = updateGoalStatus(goalQueueRef.current, activeGoal.id, "completed", {
            completionEvidence: completion.evidence,
            fallbackUsed,
          });
          const remaining = removeCompletedGoals(completedQueue);
          applyGoalQueue(remaining, { syncComposer: true });
          goalQueueDirtyRef.current = false;
          pushFeed(
            "success",
            remaining.length > 0
              ? `Goal complete: "${goal}". Continuing with the next pending goal.`
              : `Goal complete: "${goal}".`,
            { dedupeKey: `goal-complete-${activeGoal.fingerprint}`, dedupeMs: 2000 },
          );
        }
      } else if (plan.status !== "ok") {
        applyGoalQueue(updateGoalStatus(goalQueueRef.current, activeGoal.id, "blocked", { fallbackUsed }));
        patchPlannerState({
          safetyState: "ready_for_next_step",
          whatDoingNow: "Paused for clarification to avoid guessing.",
          whatNext: "Please confirm the exact item or control you want.",
        });
      }
      await postSandboxRunEvent({
        runId: run.runId,
        step: "extension_turn",
        eventType: "planner_turn_completed",
        metadata: { turnId, status: plan.status, actionType: plan.action.type },
      }).catch(() => undefined);
    } catch (error) {
      const message = toUserFacingError(error);
      if (dispatchCommitted && activeGoal) {
        applyGoalQueue(updateGoalStatus(goalQueueRef.current, activeGoal.id, "blocked"));
      }
      if (/screenshot|capture/i.test(message)) {
        const screenshotMessage = `I can't continue because screenshot capture failed: ${message}`;
        pushFeed("error", screenshotMessage);
        patchPlannerState({
          whatDoingNow: "Blocked because screenshot grounding is unavailable.",
          whatNext: "Return to the telehealth tab and try again.",
        });
      } else {
        pushFeed("error", message, { dedupeKey: `turn-error-${message}`, dedupeMs: 4000 });
        patchPlannerState({
          whatDoingNow: "Stopped due to a safe execution error.",
          whatNext: "Please review the message and retry when ready.",
        });
      }
    } finally {
      setIsRunningTurn(false);
      turnLockRef.current = false;
      if (!dispatchCommitted && turnContext === null) {
        goalQueueDirtyRef.current = goalQueueDirtyRef.current || false;
      }
    }
  }, [
    applyGoalQueue,
    applySupportTransition,
    checkPageSupport,
    collectContextWithScreenshot,
    ensureGoalQueue,
    ensureSession,
    flushMicInterimToComposer,
    isRunningTurn,
    patchPlannerState,
    pushFeed,
    pushHistory,
    sendLiveMessage,
    setComposerText,
    updateHistoryOutcome,
  ]);

  useEffect(() => {
    void getHealth().catch(() => undefined);
    void checkPageSupport();
  }, [checkPageSupport]);

  useEffect(() => {
    const onActivated = () => {
      void checkPageSupport();
    };
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && (typeof changeInfo.url === "string" || changeInfo.status === "complete")) {
        void checkPageSupport();
      }
    };
    const onFocusChanged = () => {
      void checkPageSupport();
    };
    const onWindowFocus = () => {
      void checkPageSupport();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkPageSupport();
      }
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkPageSupport]);

  useEffect(() => {
    return () => {
      void stopMic();
      const socket = liveSocketRef.current;
      if (socket) socket.close();
    };
  }, [stopMic]);

  const statusText = useMemo(() => {
    if (supportState.status === "unsupported") {
      return "You're on a different page. Return to the SilverVisit telehealth tab so I can continue safely.";
    }
    if (isRunningTurn) return "Running one grounded turn.";
    if (latestPlan?.status === "ok") return "Ready for next step.";
    if (latestPlan?.status === "need_clarification") return "Clarification needed.";
    if (latestPlan?.status === "error") return "Planner reported an error.";
    return "Waiting for your goal.";
  }, [isRunningTurn, latestPlan?.status, supportState.status]);

  const activeGoal = useMemo(() => getActiveGoal(goalQueue), [goalQueue]);
  const pendingGoalCount = useMemo(
    () => goalQueue.filter((goal) => goal.status !== "completed").length,
    [goalQueue],
  );
  const liveStateLabel = liveStatus === "live_ready" ? "Live Ready" : liveStatus === "socket_connected_not_ready" ? "Waiting Ready" : liveStatus;
  const supportReason = supportState.status === "unsupported" ? supportState.reason ?? buildUnsupportedPageReason(supportState.activeUrl) : "";
  const supportOverrideState: PlannerState | null =
    supportState.status === "unsupported"
      ? {
          safetyState: "ready_for_next_step",
          whatFound: `You're currently on a non-telehealth page (${supportState.activeUrl ?? "unknown URL"}).`,
          whatDoingNow: "Paused to prevent unsafe actions on this page.",
          whatNext: "Please return to the SilverVisit telehealth tab and I'll continue your goal.",
        }
      : null;
  const renderedPlannerState = supportOverrideState ?? plannerState;
  const safetyStateLabel = renderedPlannerState.safetyState.replaceAll("_", " ");

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_right,_#dbeafe,_#f8fafc_45%,_#f1f5f9)] text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-5 px-5 py-6">
        <header className="rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-xl shadow-sky-100/40">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-700">SilverVisit AI Navigator</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-950">Telehealth Join Assistant</h1>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-sky-100 px-3 py-1 font-semibold text-sky-700">Live: {liveStateLabel}</span>
            <span className="rounded-full bg-violet-100 px-3 py-1 font-semibold text-violet-700">Backend: {getBackendBaseUrl()}</span>
          </div>
        </header>

        <section className="rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-xl shadow-slate-200/30">
          <h2 className="text-xl font-bold text-slate-950">Ask SilverVisit</h2>
          <p className="mt-1 text-sm text-slate-600">{statusText}</p>
          <p className="mt-1 text-xs text-slate-500">
            Active goal: {activeGoal?.text ?? "None"} {pendingGoalCount > 1 ? `(${pendingGoalCount} queued)` : ""}
          </p>
          <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">State</p>
            <p className="text-lg font-bold text-slate-900">{safetyStateLabel}</p>
            <p className="mt-2 text-sm text-slate-700"><span className="font-semibold">What I found:</span> {renderedPlannerState.whatFound}</p>
            <p className="mt-1 text-sm text-slate-700"><span className="font-semibold">What I'm doing now:</span> {renderedPlannerState.whatDoingNow}</p>
            <p className="mt-1 text-sm text-slate-700"><span className="font-semibold">What you should do next:</span> {renderedPlannerState.whatNext}</p>
          </div>
          <div className="mt-4 rounded-2xl border border-slate-300 bg-slate-50 p-3">
            <div className="flex items-end gap-3">
              <textarea
                value={userGoal}
                onChange={(event) => setComposerText(event.target.value)}
                rows={4}
                className="w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-base leading-7 outline-none ring-sky-500 transition focus:ring-2"
                placeholder="Speak with mic or type your patient goal."
              />
              <button
                type="button"
                onClick={() => void startMic()}
                className={`h-12 min-w-12 rounded-full border text-sm font-semibold transition ${
                  isMicListening ? "border-rose-300 bg-rose-100 text-rose-700" : "border-sky-300 bg-sky-100 text-sky-700"
                }`}
              >
                {isMicListening ? "Stop" : "Mic"}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void runPrimaryTurn()}
            disabled={isRunningTurn}
            className="mt-4 w-full rounded-2xl bg-slate-950 px-6 py-4 text-base font-bold text-white transition hover:bg-sky-700 disabled:cursor-wait disabled:bg-slate-500"
          >
            {isRunningTurn ? "Running Guided Step..." : "Run One Grounded Step"}
          </button>
          {supportReason ? <p className="mt-3 text-sm text-amber-700">{supportReason}</p> : null}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-xl shadow-slate-200/30">
          <h3 className="text-lg font-bold text-slate-950">Progress Feed</h3>
          <div className="mt-3 max-h-64 space-y-2 overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-3">
            {feed.map((entry, index) => (
              <p key={`${entry.time}-${index}`} className={`text-sm ${toneClass(entry.tone)}`}>
                {entry.time} {entry.text}
              </p>
            ))}
          </div>
        </section>

        <details className="rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-lg">
          <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.15em] text-slate-700">Developer Details</summary>
          <div className="mt-4 space-y-4 text-sm text-slate-700">
            <p>Session ID: {sessionId ?? "Not started"}</p>
            <p>Run ID: {activeRunId ?? "Not started"}</p>
            <p>Fixture: {activeFixture ? `${activeFixture.patientName} | ${activeFixture.doctorName}` : "N/A"}</p>
            <p>Latest turn ID: {latestTurnId ?? "N/A"}</p>
            <p>Latest action: {latestPlan ? describeAction(latestPlan.action) : "N/A"}</p>
            <p>Coverage: click={clickExecutions}, type={typeExecutions}</p>
            <div className="max-h-56 space-y-2 overflow-auto rounded-xl border border-slate-200 bg-white p-3">
              {actionHistory.length === 0 ? (
                <p className="text-xs text-slate-500">Grounded action history appears here.</p>
              ) : (
                actionHistory.map((entry) => (
                  <p key={entry.id} className="text-xs text-slate-700">
                    {entry.timestamp} turn={entry.turnId.slice(0, 8)} status={entry.status} action={entry.actionType} target={entry.targetId} grounded=[{entry.groundedIds.join(",")}] {entry.outcome ? `outcome=${entry.outcome}` : ""}
                  </p>
                ))
              )}
            </div>
            <div className="max-h-56 space-y-2 overflow-auto rounded-xl border border-slate-200 bg-white p-3">
              {liveEntries.length === 0 ? (
                <p className="text-xs text-slate-500">Live event evidence appears here.</p>
              ) : (
                liveEntries.map((entry, index) => (
                  <p key={`${entry.time}-${index}`} className="text-xs text-slate-700">
                    {entry.time} {entry.kind}: {entry.text}
                  </p>
                ))
              )}
            </div>
          </div>
        </details>
      </div>
    </main>
  );
}

