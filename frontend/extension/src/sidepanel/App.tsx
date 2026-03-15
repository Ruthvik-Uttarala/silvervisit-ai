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
import { LiveAudioRecorder } from "../lib/liveAudio";
import type {
  ActionObject,
  BackgroundMessage,
  BackgroundResponse,
  PageContextWithScreenshot,
  PlanActionResponse,
  SandboxFixtureContext,
} from "../lib/types";

const DEFAULT_USER_GOAL = "Help me join my doctor appointment.";
const TURN_COOLDOWN_MS = 900;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SUPPORTED_LOCAL_PORT = "4173";

type LiveStatus = "disconnected" | "connecting" | "socket_connected_not_ready" | "live_ready" | "error";
type Tone = "info" | "success" | "warning" | "error";

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

function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function trimItems<T>(items: T[], max = 120): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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

function isSupportedSandboxUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return parsed.port === SUPPORTED_LOCAL_PORT;
    }
    return host.includes("silvervisit");
  } catch {
    return false;
  }
}

function sanitizeImagePayload(mimeType: string, base64: string): string {
  const normalizedMime = mimeType.trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(normalizedMime)) {
    throw new Error(`Unsupported screenshot mime type: ${mimeType}`);
  }
  return base64.trim().replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
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
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeFixture, setActiveFixture] = useState<SandboxFixtureContext | null>(null);
  const [clickExecutions, setClickExecutions] = useState(0);
  const [typeExecutions, setTypeExecutions] = useState(0);
  const [latestTurnId, setLatestTurnId] = useState<string | null>(null);

  const turnLockRef = useRef(false);
  const lastTurnAtRef = useRef(0);
  const capturePromiseRef = useRef<Promise<PageContextWithScreenshot> | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const liveStatusRef = useRef<LiveStatus>("disconnected");
  const liveConnectionIdRef = useRef(0);
  const sentLiveMessageIdsRef = useRef<Set<string>>(new Set());
  const liveAudioRecorderRef = useRef<LiveAudioRecorder | null>(null);
  const isMicListeningRef = useRef(false);
  const speechRef = useRef<any>(null);
  const speechBaseGoalRef = useRef("");
  const micTurnIdRef = useRef("");
  const liveTurnSendGuardRef = useRef<Set<string>>(new Set());
  const audioChunkEvidenceRef = useRef<{ turnId: string; firstChunkSeen: boolean }>({ turnId: "", firstChunkSeen: false });

  const pushFeed = useCallback((tone: Tone, text: string) => {
    setFeed((prev) => trimItems([...prev, { tone, text, time: nowLabel() }]));
  }, []);

  const pushLive = useCallback((entry: LiveEntry) => {
    setLiveEntries((prev) => trimItems([...prev, entry], 200));
  }, []);

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
    const tab = await sendBackgroundMessage<{ ok: true; tab: { url?: string; tabId: number } }>({ type: "GET_ACTIVE_TAB" });
    if (!isSupportedSandboxUrl(tab.tab.url)) {
      const shownUrl = tab.tab.url?.trim() || "unknown URL";
      const reason = `Unsupported page (${shownUrl}). Return to the SilverVisit telehealth app on ${SUPPORTED_LOCAL_PORT} to continue.`;
      setUnsupportedReason(reason);
      return { ok: false, url: tab.tab.url };
    }
    setUnsupportedReason(null);
    return { ok: true, url: tab.tab.url };
  }, []);

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
    setAuthoritativeLiveStatus("connecting");
    pushFeed("info", "Mic starting. Connecting to Gemini Live...");
    const connectionId = liveConnectionIdRef.current + 1;
    liveConnectionIdRef.current = connectionId;
    const socket = new WebSocket(`${getBackendWsUrl()}/api/live`);
    liveSocketRef.current = socket;
    sentLiveMessageIdsRef.current.clear();
    socket.onopen = () => {
      if (liveConnectionIdRef.current !== connectionId || liveSocketRef.current !== socket) return;
      setAuthoritativeLiveStatus("socket_connected_not_ready");
      sendLiveMessage({ type: "start", userGoal: goal, sessionId: sid });
      pushLive({ kind: "event", text: "Live socket connected.", time: nowLabel() });
      pushFeed("info", "Live socket connected. Waiting for live_ready...");
    };
    socket.onmessage = (event) => {
      if (liveConnectionIdRef.current !== connectionId || liveSocketRef.current !== socket) return;
      const parsed = JSON.parse(event.data as string) as any;
      if (parsed.type === "live_ready") {
        setAuthoritativeLiveStatus("live_ready");
        pushLive({ kind: "event", text: "live_ready received.", time: nowLabel() });
        pushFeed("success", "Live is ready for text, image, and audio.");
      } else if (parsed.type === "error") {
        setAuthoritativeLiveStatus("error");
        pushLive({ kind: "error", text: `${parsed.code}: ${parsed.message}`, time: nowLabel() });
        pushFeed("error", `${parsed.code}: ${parsed.message}`);
      } else if (parsed.type === "model_text") {
        pushLive({ kind: "model_text", text: parsed.text, time: nowLabel() });
        if (!speechRef.current && isMicListeningRef.current && typeof parsed.text === "string" && parsed.text.trim()) {
          setUserGoal((prev) => {
            const merged = `${prev.trim()} ${parsed.text.trim()}`.trim();
            return merged.length > 500 ? merged.slice(0, 500) : merged;
          });
        }
      } else if (parsed.type === "transcript") {
        pushLive({ kind: "transcript", text: `${parsed.role}: ${parsed.text}`, time: nowLabel() });
        if (typeof parsed.text === "string" && parsed.text.trim()) {
          pushFeed("info", `Transcript received (${parsed.role}).`);
        }
        if (
          !speechRef.current &&
          isMicListeningRef.current &&
          parsed.role === "user" &&
          typeof parsed.text === "string" &&
          parsed.text.trim()
        ) {
          setUserGoal((prev) => {
            const merged = `${prev.trim()} ${parsed.text.trim()}`.trim();
            return merged.length > 500 ? merged.slice(0, 500) : merged;
          });
        }
      }
    };
    socket.onclose = () => {
      if (liveConnectionIdRef.current !== connectionId) return;
      if (liveStatusRef.current !== "error") {
        setAuthoritativeLiveStatus("disconnected");
      }
    };
    socket.onerror = () => {
      setAuthoritativeLiveStatus("error");
    };
  }, [pushFeed, pushLive, sendLiveMessage, setAuthoritativeLiveStatus]);

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
    const recorder = liveAudioRecorderRef.current;
    liveAudioRecorderRef.current = null;
    if (recorder) {
      await recorder.stop().catch(() => undefined);
    }
    setIsMicListening(false);
    isMicListeningRef.current = false;
    const turnId = micTurnIdRef.current;
    if (turnId) {
      sendLiveMessage({ type: "user_audio_chunk", turnId, audioStreamEnd: true });
      pushFeed("info", "Audio stream ended.");
      micTurnIdRef.current = "";
    }
  }, [pushFeed, sendLiveMessage, stopSpeech]);

  const startMic = useCallback(async () => {
    if (isMicListening) {
      await stopMic();
      return;
    }
    pushFeed("info", "Mic starting...");
    const goal = userGoal.trim() || DEFAULT_USER_GOAL;
    const sid = await ensureSession(goal);
    if (liveStatusRef.current !== "live_ready") {
      await connectLive(goal, sid);
      const ready = await waitForLiveReady();
      if (!ready) {
        pushFeed("error", "Live not ready. Wait for live_ready and try again.");
        return;
      }
    }
    speechBaseGoalRef.current = goal;
    const SpeechCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechCtor) {
      const speech = new SpeechCtor();
      speech.continuous = true;
      speech.interimResults = true;
      speech.lang = "en-US";
      speech.onresult = (event: any) => {
        let finalText = "";
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const value = event.results[i][0]?.transcript ?? "";
          if (!value) continue;
          if (event.results[i].isFinal) finalText += `${value} `;
          else interim += `${value} `;
        }
        const composed = `${speechBaseGoalRef.current} ${finalText} ${interim}`.trim();
        if (composed) setUserGoal(composed);
      };
      speech.start();
      speechRef.current = speech;
    }
    micTurnIdRef.current = crypto.randomUUID();
    audioChunkEvidenceRef.current = { turnId: micTurnIdRef.current, firstChunkSeen: false };
    const recorder = new LiveAudioRecorder({
      onPermissionGranted: () => pushFeed("success", "Microphone permission granted."),
      onPermissionDenied: (message) => pushFeed("error", `Microphone permission denied: ${message}`),
      onStart: () => {
        setIsMicListening(true);
        isMicListeningRef.current = true;
        pushFeed("info", "Listening...");
      },
      onChunk: (payload) => {
        if (liveStatusRef.current !== "live_ready") {
          pushFeed("warning", "Live not ready. Audio chunk skipped.");
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
      onError: (message) => pushFeed("error", `Mic pipeline error: ${message}`),
      onStop: () => {
        setIsMicListening(false);
        isMicListeningRef.current = false;
      },
    });
    liveAudioRecorderRef.current = recorder;
    await recorder.start();
  }, [connectLive, ensureSession, isMicListening, pushFeed, sendLiveMessage, stopMic, userGoal, waitForLiveReady]);

  const runPrimaryTurn = useCallback(async () => {
    if (turnLockRef.current || isRunningTurn) return;
    const goal = userGoal.trim();
    if (!goal) {
      pushFeed("warning", "Enter a goal before running.");
      return;
    }
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
    try {
      await getHealth();
      const support = await checkPageSupport();
      if (!support.ok) return;
      const sid = await ensureSession(goal);
      const run = await startSandboxRun({ seed: extractSeedFromUrl(support.url), source: "extension", navigatorSessionId: sid });
      setActiveRunId(run.runId);
      setActiveFixture(run.fixture);
      const context = await collectContextWithScreenshot();
      setUnsupportedReason(null);

      if (liveStatusRef.current === "live_ready") {
        const textKey = `${turnId}:user_text`;
        if (!liveTurnSendGuardRef.current.has(textKey)) {
          liveTurnSendGuardRef.current.add(textKey);
          sendLiveMessage({ type: "user_text", turnId, text: goal });
        }
        const imageKey = `${turnId}:user_image_frame`;
        if (!liveTurnSendGuardRef.current.has(imageKey)) {
          liveTurnSendGuardRef.current.add(imageKey);
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

      const plan = await planAction({
        sessionId: sid,
        userGoal: goal,
        pageUrl: context.snapshot.pageUrl || context.tab.url,
        pageTitle: context.snapshot.pageTitle || context.tab.title,
        visibleText: context.snapshot.visibleText,
        elements: context.snapshot.elements,
        screenshotMimeType: context.screenshot.mimeType,
        screenshotBase64: context.screenshot.base64,
        sandboxFixture: run.fixture,
      });
      setLatestPlan(plan);
      pushFeed(
        plan.status === "ok" ? "success" : plan.status === "need_clarification" ? "warning" : "error",
        `${plan.status}: ${describeAction(plan.action)} (turn ${turnId.slice(0, 8)})`,
      );
      if (plan.status === "ok" && canExecuteAction(plan.action)) {
        const response = await sendBackgroundMessage<{ ok: true; message: string }>({
          type: plan.action.type === "highlight" && plan.action.targetId ? "HIGHLIGHT" : "EXECUTE_ACTION",
          ...(plan.action.type === "highlight" && plan.action.targetId ? { id: plan.action.targetId } : { action: plan.action }),
        } as BackgroundMessage);
        pushFeed("success", response.message);
        if (plan.action.type === "click") setClickExecutions((v) => v + 1);
        if (plan.action.type === "type") setTypeExecutions((v) => v + 1);
      }
      await postSandboxRunEvent({
        runId: run.runId,
        step: "extension_turn",
        eventType: "planner_turn_completed",
        metadata: { turnId, status: plan.status, actionType: plan.action.type },
      }).catch(() => undefined);
    } catch (error) {
      pushFeed("error", toErrorMessage(error));
    } finally {
      setIsRunningTurn(false);
      turnLockRef.current = false;
    }
  }, [checkPageSupport, collectContextWithScreenshot, ensureSession, isRunningTurn, pushFeed, sendLiveMessage, userGoal]);

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
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
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
    if (isRunningTurn) return "Running one grounded turn.";
    if (latestPlan?.status === "ok") return "Ready for next step.";
    if (latestPlan?.status === "need_clarification") return "Clarification needed.";
    if (latestPlan?.status === "error") return "Planner reported an error.";
    return "Waiting for your goal.";
  }, [isRunningTurn, latestPlan?.status]);

  const liveStateLabel = liveStatus === "live_ready" ? "Live Ready" : liveStatus === "socket_connected_not_ready" ? "Waiting Ready" : liveStatus;

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
          <div className="mt-4 rounded-2xl border border-slate-300 bg-slate-50 p-3">
            <div className="flex items-end gap-3">
              <textarea
                value={userGoal}
                onChange={(event) => setUserGoal(event.target.value)}
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
          {unsupportedReason ? <p className="mt-3 text-sm text-amber-700">{unsupportedReason}</p> : null}
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
