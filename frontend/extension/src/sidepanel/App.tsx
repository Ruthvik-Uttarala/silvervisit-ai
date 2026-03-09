import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBackendBaseUrl, getBackendWsUrl, planAction, startSession } from "../lib/api";
import type {
  ActionObject,
  BackgroundMessage,
  BackgroundResponse,
  PageContextWithScreenshot,
  PlanActionResponse,
} from "../lib/types";

const DEFAULT_USER_GOAL = "Help me join my doctor appointment";

type LiveStatus = "disconnected" | "connecting" | "connected";

interface CapabilityCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface LiveWireMessage {
  type: string;
  text?: string;
  role?: string;
  code?: string;
  message?: string;
}

async function containsPermissions(query: chrome.permissions.Permissions): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    chrome.permissions.contains(query, (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

async function sendBackgroundMessage<T extends BackgroundResponse>(message: BackgroundMessage): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as T;
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response;
}

function nowTimeLabel() {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function trimTranscript(items: string[], max = 80) {
  return items.length > max ? items.slice(items.length - max) : items;
}

function describeAction(action: ActionObject) {
  const base = action.type;
  const target = action.targetId ? ` target=${action.targetId}` : "";
  const value = action.value ? ` value=\"${action.value}\"` : "";
  const direction = action.direction ? ` direction=${action.direction}` : "";
  const amount = action.amount ? ` amount=${action.amount}` : "";
  return `${base}${target}${value}${direction}${amount}`;
}

function canExecuteAction(action: ActionObject) {
  return action.type !== "ask_user" && action.type !== "done";
}

function statusTone(status: PlanActionResponse["status"] | null) {
  if (status === "ok") {
    return "text-emerald-700";
  }
  if (status === "need_clarification") {
    return "text-amber-700";
  }
  if (status === "error") {
    return "text-red-700";
  }
  return "text-slate-700";
}

export default function App() {
  const [userGoal, setUserGoal] = useState(DEFAULT_USER_GOAL);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [latestPlan, setLatestPlan] = useState<PlanActionResponse | null>(null);
  const [transcript, setTranscript] = useState<string[]>([
    "SilverVisit is ready. Enter your goal and click Run Next Step.",
  ]);
  const [isRunningStep, setIsRunningStep] = useState(false);
  const [clickExecutions, setClickExecutions] = useState(0);
  const [typeExecutions, setTypeExecutions] = useState(0);

  const [capabilityChecks, setCapabilityChecks] = useState<CapabilityCheck[]>([]);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("disconnected");
  const [liveInput, setLiveInput] = useState("Please guide me through the current screen.");
  const [liveTranscript, setLiveTranscript] = useState<string[]>([]);

  const liveSocketRef = useRef<WebSocket | null>(null);

  const appendTranscript = useCallback((line: string) => {
    setTranscript((prev) => trimTranscript([...prev, `${nowTimeLabel()} ${line}`]));
  }, []);

  const appendLiveTranscript = useCallback((line: string) => {
    setLiveTranscript((prev) => trimTranscript([...prev, `${nowTimeLabel()} ${line}`]));
  }, []);

  const ensureSession = useCallback(
    async (goal: string) => {
      if (sessionId) {
        return sessionId;
      }

      const session = await startSession({ userGoal: goal });
      setSessionId(session.sessionId);
      appendTranscript(`Started session ${session.sessionId}.`);
      return session.sessionId;
    },
    [appendTranscript, sessionId],
  );

  const collectContextWithScreenshot = useCallback(async (): Promise<PageContextWithScreenshot> => {
    const response = await sendBackgroundMessage<{ ok: true; context: PageContextWithScreenshot }>({
      type: "COLLECT_CONTEXT_WITH_SCREENSHOT",
    });

    if (!response.context.screenshot?.base64 || !response.context.screenshot?.mimeType) {
      throw new Error("Screenshot capture is required for the happy path. Please keep the telehealth tab visible and retry.");
    }

    return response.context;
  }, []);

  const executePlannedAction = useCallback(
    async (plan: PlanActionResponse) => {
      if (plan.status !== "ok" || !canExecuteAction(plan.action)) {
        return;
      }

      let executeMessage = "";
      if (plan.action.type === "highlight" && plan.action.targetId) {
        const response = await sendBackgroundMessage<{ ok: true; message: string }>({
          type: "HIGHLIGHT",
          id: plan.action.targetId,
        });
        executeMessage = response.message;
      } else {
        const response = await sendBackgroundMessage<{ ok: true; message: string }>({
          type: "EXECUTE_ACTION",
          action: plan.action,
        });
        executeMessage = response.message;
      }

      if (plan.action.type === "click") {
        setClickExecutions((value) => value + 1);
      }
      if (plan.action.type === "type") {
        setTypeExecutions((value) => value + 1);
      }

      appendTranscript(`Executed ${describeAction(plan.action)}. ${executeMessage}`);
    },
    [appendTranscript],
  );

  const runNextStep = useCallback(async () => {
    const goal = userGoal.trim();
    if (!goal) {
      appendTranscript("Please enter a goal before running the next step.");
      return;
    }

    setIsRunningStep(true);
    try {
      const currentSessionId = await ensureSession(goal);
      const context = await collectContextWithScreenshot();
      appendTranscript(
        `Captured ${context.snapshot.elements.length} actionable elements, ${context.snapshot.visibleText.length} visible text snippets, and a screenshot.`,
      );

      const plan = await planAction({
        sessionId: currentSessionId,
        userGoal: goal,
        pageUrl: context.snapshot.pageUrl || context.tab.url,
        pageTitle: context.snapshot.pageTitle || context.tab.title,
        visibleText: context.snapshot.visibleText,
        elements: context.snapshot.elements,
        screenshotMimeType: context.screenshot.mimeType,
        screenshotBase64: context.screenshot.base64,
      });

      setLatestPlan(plan);
      appendTranscript(`Planner status=${plan.status}. Next action: ${describeAction(plan.action)}.`);
      appendTranscript(`Grounding: ${plan.grounding.reasoningSummary}`);

      await executePlannedAction(plan);
    } catch (error) {
      appendTranscript(`Step failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsRunningStep(false);
    }
  }, [appendTranscript, collectContextWithScreenshot, ensureSession, executePlannedAction, userGoal]);

  const runPermissionDiagnostics = useCallback(async () => {
    const checks: CapabilityCheck[] = [];

    const permissionCheck = async (
      id: string,
      label: string,
      permissions: chrome.runtime.ManifestPermission[] = [],
      origins: string[] = [],
    ) => {
      try {
        const ok = await containsPermissions({ permissions, origins });
        checks.push({
          id,
          label,
          ok,
          detail: ok ? "Available" : "Missing from extension runtime permissions.",
        });
      } catch (error) {
        checks.push({
          id,
          label,
          ok: false,
          detail: error instanceof Error ? error.message : "Permission check failed.",
        });
      }
    };

    await permissionCheck("sidePanel", "MV3 side panel", ["sidePanel"]);
    await permissionCheck("tabs", "Active tab inspection", ["tabs"]);
    await permissionCheck("activeTab", "Active tab grant", ["activeTab"]);
    await permissionCheck("scripting", "Content script execution", ["scripting"]);
    await permissionCheck("host", "Host access for sandbox capture", [], ["<all_urls>"]);

    try {
      const tabResponse = await sendBackgroundMessage<{ ok: true; tab: { tabId: number; title?: string } }>({
        type: "GET_ACTIVE_TAB",
      });
      checks.push({
        id: "activeTabResolution",
        label: "Active tab resolvable",
        ok: true,
        detail: `Tab ${tabResponse.tab.tabId}${tabResponse.tab.title ? ` (${tabResponse.tab.title})` : ""}`,
      });
    } catch (error) {
      checks.push({
        id: "activeTabResolution",
        label: "Active tab resolvable",
        ok: false,
        detail: error instanceof Error ? error.message : "Failed to resolve active tab.",
      });
    }

    setCapabilityChecks(checks);
  }, []);

  const disconnectLive = useCallback(() => {
    const socket = liveSocketRef.current;
    if (!socket) {
      setLiveStatus("disconnected");
      return;
    }

    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "end" }));
      }
      socket.close();
    } catch {
      // Ignore local close race conditions.
    }

    liveSocketRef.current = null;
    setLiveStatus("disconnected");
  }, []);

  const connectLive = useCallback(async () => {
    if (liveStatus === "connecting" || liveStatus === "connected") {
      return;
    }

    const goal = userGoal.trim() || DEFAULT_USER_GOAL;
    setLiveStatus("connecting");

    try {
      const sid = await ensureSession(goal);
      const socket = new WebSocket(`${getBackendWsUrl()}/api/live`);
      liveSocketRef.current = socket;

      socket.onopen = () => {
        setLiveStatus("connected");
        socket.send(
          JSON.stringify({
            type: "start",
            sessionId: sid,
            userGoal: goal,
          }),
        );
        appendLiveTranscript("Connected to live session.");
      };

      socket.onmessage = (event) => {
        let parsed: LiveWireMessage | null = null;
        try {
          parsed = JSON.parse(event.data as string) as LiveWireMessage;
        } catch {
          appendLiveTranscript(`Raw message: ${String(event.data)}`);
          return;
        }

        if (!parsed) {
          return;
        }

        if (parsed.type === "error") {
          appendLiveTranscript(`Live error [${parsed.code}]: ${parsed.message}`);
          return;
        }

        if (parsed.type === "model_text" && parsed.text) {
          appendLiveTranscript(`Model: ${parsed.text}`);
          return;
        }

        if (parsed.type === "transcript" && parsed.text) {
          appendLiveTranscript(`${parsed.role ?? "system"}: ${parsed.text}`);
          return;
        }

        appendLiveTranscript(`Live event: ${parsed.type}`);
      };

      socket.onerror = () => {
        appendLiveTranscript("Live socket error occurred.");
      };

      socket.onclose = () => {
        setLiveStatus("disconnected");
        appendLiveTranscript("Live session disconnected.");
      };
    } catch (error) {
      setLiveStatus("disconnected");
      appendLiveTranscript(`Failed to connect live session: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }, [appendLiveTranscript, ensureSession, liveStatus, userGoal]);

  const sendLiveTextAndFrame = useCallback(async () => {
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLiveTranscript("Connect live session first.");
      return;
    }

    const text = liveInput.trim();
    if (!text) {
      appendLiveTranscript("Enter a live message before sending.");
      return;
    }

    try {
      const context = await collectContextWithScreenshot();
      socket.send(JSON.stringify({ type: "user_text", text }));
      socket.send(
        JSON.stringify({
          type: "user_image_frame",
          mimeType: context.screenshot.mimeType,
          dataBase64: context.screenshot.base64,
        }),
      );
      appendLiveTranscript("Sent live text and current image frame.");
    } catch (error) {
      appendLiveTranscript(`Failed to send live text+frame: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }, [appendLiveTranscript, collectContextWithScreenshot, liveInput]);

  const sendLiveAudioProbe = useCallback(() => {
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLiveTranscript("Connect live session first.");
      return;
    }

    socket.send(
      JSON.stringify({
        type: "user_audio_chunk",
        mimeType: "audio/pcm",
        dataBase64: btoa("demo-audio-probe"),
      }),
    );
    appendLiveTranscript("Sent audio probe chunk (expected graceful unsupported response unless PCM path is enabled).");
  }, [appendLiveTranscript]);

  useEffect(() => {
    void runPermissionDiagnostics();
  }, [runPermissionDiagnostics]);

  useEffect(() => {
    return () => {
      disconnectLive();
    };
  }, [disconnectLive]);

  const statusText = useMemo(() => {
    if (isRunningStep) {
      return "Analyzing screenshot and selecting one safe next action...";
    }
    if (latestPlan?.status === "ok") {
      return "Ready for the next grounded step.";
    }
    if (latestPlan?.status === "need_clarification") {
      return "Waiting for your clarification.";
    }
    if (latestPlan?.status === "error") {
      return "Planner reported an error. Review transcript and retry.";
    }
    return "Waiting for your first step.";
  }, [isRunningStep, latestPlan?.status]);

  const hasExecutableCoverage = clickExecutions > 0 && typeExecutions > 0;

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-5 px-5 py-6">
        <header className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-700">SilverVisit UI Navigator</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Telehealth Join Assistant</h1>
          <p className="mt-3 text-lg leading-8 text-slate-700">
            One grounded action at a time. Screenshot is required for every happy-path planning step.
          </p>
        </header>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <label htmlFor="goal" className="text-base font-bold text-slate-900">
            Patient Goal
          </label>
          <textarea
            id="goal"
            value={userGoal}
            onChange={(event) => setUserGoal(event.target.value)}
            rows={3}
            className="mt-2 w-full rounded-2xl border-2 border-slate-300 px-4 py-3 text-lg leading-8 focus:border-sky-600 focus:outline-none"
            placeholder="Example: Help me join my doctor appointment."
          />
          <p className={`mt-3 text-lg font-semibold ${statusTone(latestPlan?.status ?? null)}`}>Status: {statusText}</p>
          <p className="mt-2 text-sm text-slate-600">Backend: {getBackendBaseUrl()}</p>
        </section>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void runNextStep()}
              disabled={isRunningStep}
              className="rounded-2xl bg-slate-950 px-5 py-3 text-lg font-black text-white transition hover:bg-sky-700 disabled:cursor-progress disabled:bg-slate-600"
            >
              {isRunningStep ? "Running Step..." : "Run Next Step (Screenshot Required)"}
            </button>
            <button
              type="button"
              onClick={() => void runPermissionDiagnostics()}
              className="rounded-2xl border-2 border-slate-900 bg-white px-5 py-3 text-lg font-bold text-slate-900"
            >
              Recheck Permissions
            </button>
          </div>

          <div className="mt-4 grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            {capabilityChecks.map((check) => (
              <p key={check.id} className={`text-base ${check.ok ? "text-emerald-700" : "text-red-700"}`}>
                {check.ok ? "OK" : "Missing"} - {check.label}: {check.detail}
              </p>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <h2 className="text-xl font-black text-slate-950">Execution Coverage</h2>
          <p className="mt-2 text-base text-slate-700">Grounded click executions: {clickExecutions}</p>
          <p className="text-base text-slate-700">Grounded type executions: {typeExecutions}</p>
          <p className={`mt-2 text-base font-bold ${hasExecutableCoverage ? "text-emerald-700" : "text-amber-700"}`}>
            {hasExecutableCoverage
              ? "Coverage met: at least one click and one type action executed."
              : "Coverage pending: run more steps until both click and type execute."}
          </p>
        </section>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <h2 className="text-xl font-black text-slate-950">Latest Planner Result</h2>
          <div className="mt-3 space-y-2 text-base text-slate-800">
            <p>Session: {sessionId ?? "Not started"}</p>
            <p>Status: {latestPlan?.status ?? "N/A"}</p>
            <p>Action: {latestPlan ? describeAction(latestPlan.action) : "N/A"}</p>
            <p>Confidence: {latestPlan ? `${Math.round(latestPlan.confidence * 100)}%` : "N/A"}</p>
            <p>Grounding: {latestPlan?.grounding.reasoningSummary ?? "N/A"}</p>
          </div>
        </section>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <h2 className="text-xl font-black text-slate-950">Live Session (Text + Image)</h2>
          <p className="mt-2 text-base text-slate-700">Status: {liveStatus}</p>
          <textarea
            value={liveInput}
            onChange={(event) => setLiveInput(event.target.value)}
            rows={2}
            className="mt-3 w-full rounded-2xl border-2 border-slate-300 px-4 py-3 text-base leading-7 focus:border-sky-600 focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void connectLive()}
              disabled={liveStatus !== "disconnected"}
              className="rounded-2xl bg-slate-900 px-4 py-2 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-600"
            >
              Start Live
            </button>
            <button
              type="button"
              onClick={() => void sendLiveTextAndFrame()}
              disabled={liveStatus !== "connected"}
              className="rounded-2xl bg-sky-700 px-4 py-2 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-500"
            >
              Send Text + Current Frame
            </button>
            <button
              type="button"
              onClick={sendLiveAudioProbe}
              disabled={liveStatus !== "connected"}
              className="rounded-2xl border-2 border-slate-900 px-4 py-2 text-base font-bold text-slate-900 disabled:cursor-not-allowed disabled:border-slate-400 disabled:text-slate-500"
            >
              Send Audio Probe
            </button>
            <button
              type="button"
              onClick={disconnectLive}
              disabled={liveStatus === "disconnected"}
              className="rounded-2xl bg-rose-700 px-4 py-2 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-500"
            >
              End Live
            </button>
          </div>

          <div className="mt-4 max-h-48 space-y-2 overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-3">
            {liveTranscript.length === 0 ? (
              <p className="text-sm text-slate-600">Live transcript will appear here.</p>
            ) : (
              liveTranscript.map((line, index) => (
                <p key={`${line}-${index}`} className="text-sm text-slate-800">
                  {line}
                </p>
              ))
            )}
          </div>
        </section>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <h2 className="text-xl font-black text-slate-950">Navigator Transcript</h2>
          <div className="mt-4 max-h-80 space-y-2 overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-4">
            {transcript.map((line, index) => (
              <p key={`${line}-${index}`} className="text-base leading-7 text-slate-900">
                {line}
              </p>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
