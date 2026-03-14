import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBackendBaseUrl, getBackendWsUrl, getHealth, planAction, startSession } from "../lib/api";
import type {
  ActionObject,
  BackgroundMessage,
  BackgroundResponse,
  PageContextWithScreenshot,
  PlanActionResponse,
} from "../lib/types";

const DEFAULT_USER_GOAL = "Help me join my doctor appointment";
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type LiveStatus =
  | "disconnected"
  | "connecting"
  | "socket_connected_not_ready"
  | "live_ready"
  | "error";
type DiagnosticState = "idle" | "running" | "ok" | "warning" | "error";

interface CapabilityCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface RuntimeDiagnostic {
  state: DiagnosticState;
  detail: string;
}

interface RuntimeDiagnostics {
  activeTab: RuntimeDiagnostic;
  contentScript: RuntimeDiagnostic;
  screenshot: RuntimeDiagnostic;
  backend: RuntimeDiagnostic;
  live: RuntimeDiagnostic;
}

interface LiveWireMessage {
  type: string;
  text?: string;
  role?: string;
  code?: string;
  message?: string;
}

interface LiveEntry {
  kind: "event" | "model_text" | "transcript" | "error";
  text: string;
  time: string;
}

const DEFAULT_RUNTIME_DIAGNOSTICS: RuntimeDiagnostics = {
  activeTab: { state: "idle", detail: "Not checked yet." },
  contentScript: { state: "idle", detail: "Not checked yet." },
  screenshot: { state: "idle", detail: "No screenshot captured yet." },
  backend: { state: "idle", detail: "Not checked yet." },
  live: { state: "idle", detail: "Disconnected." },
};

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

function trimItems<T>(items: T[], max = 80) {
  return items.length > max ? items.slice(items.length - max) : items;
}

function describeAction(action: ActionObject) {
  const base = action.type;
  const target = action.targetId ? ` targetId=${action.targetId}` : "";
  const value = action.value ? ` value="${action.value}"` : "";
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

function liveStatusLabel(status: LiveStatus) {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "socket_connected_not_ready":
      return "Socket Connected (Waiting for LIVE_READY)";
    case "live_ready":
      return "Live Ready";
    case "error":
      return "Error";
    default:
      return "Disconnected";
  }
}

function diagnosticTone(state: DiagnosticState) {
  if (state === "ok") {
    return "text-emerald-700";
  }
  if (state === "warning") {
    return "text-amber-700";
  }
  if (state === "error") {
    return "text-red-700";
  }
  if (state === "running") {
    return "text-sky-700";
  }
  return "text-slate-600";
}

function formatScreenshotSize(base64: string) {
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

function decodeBase64Bytes(base64: string): Uint8Array {
  const sanitized = base64.trim().replace(/\s+/g, "");
  if (!sanitized) {
    throw new Error("Image payload base64 is empty.");
  }
  const binary = atob(sanitized);
  if (!binary || binary.length === 0) {
    throw new Error("Image payload decoded to empty bytes.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function detectImageMimeType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF" &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

function normalizeImagePayload(mimeType: string, base64: string, fieldName: string): string {
  const normalizedMime = mimeType.trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(normalizedMime)) {
    throw new Error(`${fieldName} mime type is not supported: ${mimeType}`);
  }

  const sanitized = base64.trim().replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  const bytes = decodeBase64Bytes(sanitized);
  const detected = detectImageMimeType(bytes);
  if (!detected) {
    throw new Error(`${fieldName} bytes are not a valid PNG, JPEG, or WEBP image.`);
  }
  if (detected !== normalizedMime) {
    throw new Error(`${fieldName} mime mismatch. Declared ${normalizedMime}, detected ${detected}.`);
  }
  return sanitized;
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
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnostics>(DEFAULT_RUNTIME_DIAGNOSTICS);

  const [liveStatus, setLiveStatus] = useState<LiveStatus>("disconnected");
  const [liveInput, setLiveInput] = useState("Please guide me through the current screen.");
  const [liveEntries, setLiveEntries] = useState<LiveEntry[]>([]);

  const liveSocketRef = useRef<WebSocket | null>(null);
  const preserveLiveErrorOnCloseRef = useRef(false);
  const liveReady = liveStatus === "live_ready";

  const setRuntimeDiagnostic = useCallback(
    (key: keyof RuntimeDiagnostics, state: DiagnosticState, detail: string) => {
      setRuntimeDiagnostics((prev) => ({
        ...prev,
        [key]: { state, detail },
      }));
    },
    [],
  );

  const appendTranscript = useCallback((line: string) => {
    setTranscript((prev) => trimItems([...prev, `${nowTimeLabel()} ${line}`], 120));
  }, []);

  const appendLiveEntry = useCallback((entry: LiveEntry) => {
    setLiveEntries((prev) => trimItems([...prev, entry], 120));
  }, []);

  const checkBackendHealth = useCallback(async (): Promise<boolean> => {
    setRuntimeDiagnostic("backend", "running", "Checking /health...");
    try {
      const health = await getHealth();
      if (!health.ok) {
        setRuntimeDiagnostic("backend", "error", "Backend /health returned ok=false.");
        return false;
      }
      const detail = `${health.service} reachable. Vertex: ${
        health.vertexConfigured ? "configured" : "not configured"
      }. Live: ${health.liveApiConfigured ? "configured" : "not configured"}.`;
      setRuntimeDiagnostic("backend", "ok", detail);
      return true;
    } catch (error) {
      const message = toErrorMessage(error) || "Failed to reach backend.";
      setRuntimeDiagnostic("backend", "error", message);
      console.error(`[SilverVisit] Backend health check failed: ${message}`);
      return false;
    }
  }, [setRuntimeDiagnostic]);

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
    setRuntimeDiagnostic("screenshot", "running", "Capturing screenshot from the active tab...");
    try {
      const response = await sendBackgroundMessage<{ ok: true; context: PageContextWithScreenshot }>({
        type: "COLLECT_CONTEXT_WITH_SCREENSHOT",
      });

      if (!response.context.screenshot?.base64 || !response.context.screenshot?.mimeType) {
        throw new Error(
          "Screenshot capture is required for the happy path. Keep the telehealth tab visible, then retry.",
        );
      }

      const normalizedBase64 = normalizeImagePayload(
        response.context.screenshot.mimeType,
        response.context.screenshot.base64,
        "Screenshot",
      );
      response.context.screenshot.base64 = normalizedBase64;
      const screenshotSize = formatScreenshotSize(normalizedBase64);
      setRuntimeDiagnostic(
        "screenshot",
        "ok",
        `Captured ${response.context.screenshot.mimeType} (${screenshotSize}).`,
      );
      setRuntimeDiagnostic(
        "activeTab",
        "ok",
        `Tab ${response.context.tab.tabId}${response.context.tab.title ? ` (${response.context.tab.title})` : ""}.`,
      );
      setRuntimeDiagnostic("contentScript", "ok", "Content script responded with page context.");
      console.info(
        `[SilverVisit] Screenshot capture success tabId=${response.context.tab.tabId} mimeType=${response.context.screenshot.mimeType} size=${screenshotSize}`,
      );
      return response.context;
    } catch (error) {
      const message = toErrorMessage(error) || "Screenshot capture failed.";
      setRuntimeDiagnostic("screenshot", "error", message);
      console.error(`[SilverVisit] Screenshot capture failed: ${message}`);
      throw error;
    }
  }, [setRuntimeDiagnostic]);

  const executePlannedAction = useCallback(
    async (plan: PlanActionResponse) => {
      if (plan.status !== "ok" || !canExecuteAction(plan.action)) {
        if (plan.action.type === "ask_user") {
          appendTranscript("Planner requested clarification before taking action.");
        }
        if (plan.action.type === "done") {
          appendTranscript("Planner reported that this flow is complete.");
        }
        return;
      }

      if ((plan.action.type === "click" || plan.action.type === "type") && !plan.action.targetId) {
        appendTranscript(`Execution blocked: ${plan.action.type} action is missing targetId.`);
        return;
      }

      const targetLabel = plan.action.targetId ?? "none";

      try {
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

        appendTranscript(
          `Executed action type=${plan.action.type} targetId=${targetLabel} result=${executeMessage}`,
        );
        console.info(
          `[SilverVisit] Action executed type=${plan.action.type} targetId=${plan.action.targetId ?? "none"} result=${executeMessage}`,
        );
      } catch (error) {
        const message = toErrorMessage(error) || "Unknown execution error.";
        appendTranscript(`Execution blocked type=${plan.action.type} targetId=${targetLabel} error=${message}`);
        console.error(
          `[SilverVisit] Action execution failed type=${plan.action.type} targetId=${plan.action.targetId ?? "none"} error=${message}`,
        );
      }
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
    appendTranscript("Starting next guided step.");
    try {
      const backendOk = await checkBackendHealth();
      if (!backendOk) {
        throw new Error("Backend is not reachable. Start backend service and retry.");
      }

      const currentSessionId = await ensureSession(goal);
      const context = await collectContextWithScreenshot();
      appendTranscript(
        `Captured ${context.snapshot.elements.length} actionable elements, ${context.snapshot.visibleText.length} visible text snippets, and attached screenshot.`,
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
      appendTranscript(
        `Planner status=${plan.status}. action=${plan.action.type} targetId=${plan.action.targetId ?? "none"} confidence=${Math.round(
          plan.confidence * 100,
        )}%`,
      );
      appendTranscript(`Grounding summary: ${plan.grounding.reasoningSummary}`);

      await executePlannedAction(plan);
    } catch (error) {
      const message = toErrorMessage(error) || "Unknown error";
      appendTranscript(`Step failed: ${message}`);
      console.error(`[SilverVisit] Planner step failed: ${message}`);
    } finally {
      setIsRunningStep(false);
    }
  }, [appendTranscript, checkBackendHealth, collectContextWithScreenshot, ensureSession, executePlannedAction, userGoal]);

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
          detail: ok ? "Available" : "Missing from runtime permissions.",
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
    await permissionCheck("tabs", "tabs permission", ["tabs"]);
    await permissionCheck("activeTab", "activeTab permission", ["activeTab"]);
    await permissionCheck("scripting", "scripting permission", ["scripting"]);
    await permissionCheck("hostLocalhost", "Host permission localhost", [], ["http://localhost/*"]);
    await permissionCheck("hostLoopback", "Host permission 127.0.0.1", [], ["http://127.0.0.1/*"]);

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
      setRuntimeDiagnostic(
        "activeTab",
        "ok",
        `Resolved active tab ${tabResponse.tab.tabId}${tabResponse.tab.title ? ` (${tabResponse.tab.title})` : ""}.`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Failed to resolve active tab.";
      checks.push({
        id: "activeTabResolution",
        label: "Active tab resolvable",
        ok: false,
        detail,
      });
      setRuntimeDiagnostic("activeTab", "error", detail);
    }

    try {
      const pingResponse = await sendBackgroundMessage<{ ok: true; message: string }>({
        type: "PING_CONTENT_SCRIPT",
      });
      checks.push({
        id: "contentScript",
        label: "Content script channel",
        ok: true,
        detail: pingResponse.message,
      });
      setRuntimeDiagnostic("contentScript", "ok", pingResponse.message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Content script ping failed.";
      checks.push({
        id: "contentScript",
        label: "Content script channel",
        ok: false,
        detail,
      });
      setRuntimeDiagnostic("contentScript", "error", detail);
    }

    setCapabilityChecks(checks);
  }, [setRuntimeDiagnostic]);

  const disconnectLive = useCallback(() => {
    preserveLiveErrorOnCloseRef.current = false;
    const socket = liveSocketRef.current;
    if (!socket) {
      setLiveStatus("disconnected");
      setRuntimeDiagnostic("live", "idle", "Disconnected.");
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
    setRuntimeDiagnostic("live", "idle", "Disconnected.");
  }, [setRuntimeDiagnostic]);

  const connectLive = useCallback(async () => {
    if (
      liveStatus === "connecting" ||
      liveStatus === "socket_connected_not_ready" ||
      liveStatus === "live_ready"
    ) {
      return;
    }

    const goal = userGoal.trim() || DEFAULT_USER_GOAL;
    setLiveStatus("connecting");
    preserveLiveErrorOnCloseRef.current = false;
    setRuntimeDiagnostic("live", "running", "Connecting live session...");

    try {
      const sid = await ensureSession(goal);
      const socket = new WebSocket(`${getBackendWsUrl()}/api/live`);
      liveSocketRef.current = socket;

      socket.onopen = () => {
        setLiveStatus("socket_connected_not_ready");
        setRuntimeDiagnostic("live", "running", "Socket connected. Waiting for LIVE_READY acknowledgement.");
        appendLiveEntry({ kind: "event", text: "Socket connected.", time: nowTimeLabel() });
        socket.send(
          JSON.stringify({
            type: "start",
            sessionId: sid,
            userGoal: goal,
          }),
        );
        appendLiveEntry({ kind: "event", text: "Sent start request.", time: nowTimeLabel() });
      };

      socket.onmessage = (event) => {
        let parsed: LiveWireMessage | null = null;
        try {
          parsed = JSON.parse(event.data as string) as LiveWireMessage;
        } catch {
          appendLiveEntry({ kind: "event", text: `Raw message: ${String(event.data)}`, time: nowTimeLabel() });
          return;
        }

        if (!parsed) {
          return;
        }

        if (parsed.type === "error") {
          if (["live_disabled", "live_not_configured", "live_start_failed"].includes(parsed.code ?? "")) {
            preserveLiveErrorOnCloseRef.current = true;
            setLiveStatus("error");
            setRuntimeDiagnostic("live", "error", parsed.message ?? "Live start failed.");
            console.error(
              `[SilverVisit] Live start failure code=${parsed.code ?? "unknown"} message=${parsed.message ?? "unknown"}`,
            );
            liveSocketRef.current?.close();
          } else {
            console.warn(
              `[SilverVisit] Live runtime warning code=${parsed.code ?? "unknown"} message=${parsed.message ?? "unknown"}`,
            );
          }
          appendLiveEntry({
            kind: "error",
            text: `error [${parsed.code}]: ${parsed.message}`,
            time: nowTimeLabel(),
          });
          return;
        }

        if (parsed.type === "model_text" && parsed.text) {
          appendLiveEntry({ kind: "model_text", text: parsed.text, time: nowTimeLabel() });
          return;
        }

        if (parsed.type === "transcript" && parsed.text) {
          if (parsed.text.includes("LIVE_READY")) {
            setLiveStatus("live_ready");
            setRuntimeDiagnostic("live", "ok", "Live session ready.");
          }
          appendLiveEntry({
            kind: "transcript",
            text: `${parsed.role ?? "system"}: ${parsed.text}`,
            time: nowTimeLabel(),
          });
          return;
        }

        appendLiveEntry({ kind: "event", text: `event: ${parsed.type}`, time: nowTimeLabel() });
      };

      socket.onerror = () => {
        preserveLiveErrorOnCloseRef.current = true;
        setLiveStatus("error");
        setRuntimeDiagnostic("live", "error", "Live socket error occurred.");
        appendLiveEntry({ kind: "error", text: "Live socket error occurred.", time: nowTimeLabel() });
        console.error("[SilverVisit] Live socket transport error occurred.");
      };

      socket.onclose = () => {
        const preserveError = preserveLiveErrorOnCloseRef.current;
        preserveLiveErrorOnCloseRef.current = false;
        if (preserveError) {
          setLiveStatus("error");
          appendLiveEntry({ kind: "event", text: "Live session closed after an error.", time: nowTimeLabel() });
          return;
        }
        setLiveStatus("disconnected");
        setRuntimeDiagnostic("live", "idle", "Disconnected.");
        appendLiveEntry({ kind: "event", text: "Live session disconnected.", time: nowTimeLabel() });
      };
    } catch (error) {
      setLiveStatus("error");
      const message = toErrorMessage(error) || "Unknown error";
      setRuntimeDiagnostic("live", "error", message);
      appendLiveEntry({ kind: "error", text: `Failed to connect live session: ${message}`, time: nowTimeLabel() });
      console.error(`[SilverVisit] Live connection failed: ${message}`);
    }
  }, [appendLiveEntry, ensureSession, liveStatus, setRuntimeDiagnostic, userGoal]);

  const sendLiveTextAndFrame = useCallback(async () => {
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !liveReady) {
      appendLiveEntry({
        kind: "error",
        text: "Wait for LIVE_READY before sending text and frame.",
        time: nowTimeLabel(),
      });
      console.warn("[SilverVisit] Live send blocked: user_text/user_image_frame attempted before LIVE_READY.");
      return;
    }

    const text = liveInput.trim();
    if (!text) {
      appendLiveEntry({ kind: "error", text: "Enter a live message before sending.", time: nowTimeLabel() });
      return;
    }

    try {
      const context = await collectContextWithScreenshot();
      const normalizedLiveFrame = normalizeImagePayload(
        context.screenshot.mimeType,
        context.screenshot.base64,
        "Live frame",
      );
      socket.send(JSON.stringify({ type: "user_text", text }));
      appendLiveEntry({
        kind: "event",
        text: "Sent user_text.",
        time: nowTimeLabel(),
      });
      socket.send(
        JSON.stringify({
          type: "user_image_frame",
          mimeType: context.screenshot.mimeType,
          dataBase64: normalizedLiveFrame,
        }),
      );
      appendLiveEntry({
        kind: "event",
        text: "Sent user_image_frame.",
        time: nowTimeLabel(),
      });
    } catch (error) {
      const message = toErrorMessage(error) || "Unknown error";
      appendLiveEntry({ kind: "error", text: `Failed to send live text+frame: ${message}`, time: nowTimeLabel() });
      console.error(`[SilverVisit] Live text+frame send failed: ${message}`);
    }
  }, [appendLiveEntry, collectContextWithScreenshot, liveInput, liveReady]);

  const sendLiveAudioProbe = useCallback(() => {
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !liveReady) {
      appendLiveEntry({
        kind: "error",
        text: "Wait for LIVE_READY before sending audio probe.",
        time: nowTimeLabel(),
      });
      console.warn("[SilverVisit] Live audio probe blocked: attempted before LIVE_READY.");
      return;
    }

    socket.send(
      JSON.stringify({
        type: "user_audio_chunk",
        mimeType: "audio/pcm",
        dataBase64: btoa("demo-audio-probe"),
      }),
    );
    appendLiveEntry({
      kind: "event",
      text: "Sent audio probe chunk (expect graceful structured fallback unless PCM path is enabled).",
      time: nowTimeLabel(),
    });
  }, [appendLiveEntry]);

  useEffect(() => {
    void runPermissionDiagnostics();
    void checkBackendHealth();
  }, [checkBackendHealth, runPermissionDiagnostics]);

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
      return "Planner reported an error. Review diagnostics and transcript, then retry.";
    }
    return "Waiting for your first step.";
  }, [isRunningStep, latestPlan?.status]);

  const hasExecutableCoverage = clickExecutions > 0 && typeExecutions > 0;

  const currentInstruction = latestPlan
    ? `${latestPlan.message} Next action: ${describeAction(latestPlan.action)}.`
    : "Press Run Next Step to receive your first grounded instruction.";

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
          <h2 className="text-xl font-black text-slate-950">System Diagnostics</h2>
          <div className="mt-3 grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className={`text-base ${diagnosticTone(runtimeDiagnostics.activeTab.state)}`}>
              Active tab: {runtimeDiagnostics.activeTab.detail}
            </p>
            <p className={`text-base ${diagnosticTone(runtimeDiagnostics.contentScript.state)}`}>
              Content script: {runtimeDiagnostics.contentScript.detail}
            </p>
            <p className={`text-base ${diagnosticTone(runtimeDiagnostics.screenshot.state)}`}>
              Screenshot: {runtimeDiagnostics.screenshot.detail}
            </p>
            <p className={`text-base ${diagnosticTone(runtimeDiagnostics.backend.state)}`}>
              Backend /health: {runtimeDiagnostics.backend.detail}
            </p>
            <p className={`text-base ${diagnosticTone(runtimeDiagnostics.live.state)}`}>
              Live connection: {runtimeDiagnostics.live.detail}
            </p>
          </div>

          <div className="mt-4 grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            {capabilityChecks.map((check) => (
              <p key={check.id} className={`text-base ${check.ok ? "text-emerald-700" : "text-red-700"}`}>
                {check.ok ? "OK" : "Missing"} - {check.label}: {check.detail}
              </p>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void runPermissionDiagnostics()}
              className="rounded-2xl border-2 border-slate-900 bg-white px-5 py-3 text-base font-bold text-slate-900"
            >
              Recheck Permissions/Tab/Content
            </button>
            <button
              type="button"
              onClick={() => void checkBackendHealth()}
              className="rounded-2xl border-2 border-slate-900 bg-white px-5 py-3 text-base font-bold text-slate-900"
            >
              Recheck Backend Health
            </button>
          </div>
        </section>

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
          <button
            type="button"
            onClick={() => void runNextStep()}
            disabled={isRunningStep}
            className="mt-4 rounded-2xl bg-slate-950 px-5 py-3 text-lg font-black text-white transition hover:bg-sky-700 disabled:cursor-progress disabled:bg-slate-600"
          >
            {isRunningStep ? "Running Step..." : "Run Next Step (Screenshot Required)"}
          </button>
        </section>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <h2 className="text-xl font-black text-slate-950">Current Instruction</h2>
          <p className="mt-3 text-lg leading-8 text-slate-900">{currentInstruction}</p>
          <div className="mt-3 space-y-2 text-base text-slate-800">
            <p>Session: {sessionId ?? "Not started"}</p>
            <p>Status: {latestPlan?.status ?? "N/A"}</p>
            <p>Action: {latestPlan ? describeAction(latestPlan.action) : "N/A"}</p>
            <p>Confidence: {latestPlan ? `${Math.round(latestPlan.confidence * 100)}%` : "N/A"}</p>
            <p>Grounding: {latestPlan?.grounding.reasoningSummary ?? "N/A"}</p>
          </div>
        </section>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <h2 className="text-xl font-black text-slate-950">Execution Coverage</h2>
          <p className="mt-2 text-base text-slate-700">Grounded click executions: {clickExecutions}</p>
          <p className="text-base text-slate-700">Grounded type executions: {typeExecutions}</p>
          <p className={`mt-2 text-base font-bold ${hasExecutableCoverage ? "text-emerald-700" : "text-amber-700"}`}>
            {hasExecutableCoverage
              ? "Coverage met: at least one click and one type action executed."
              : "Coverage pending: run steps until both click and type succeed."}
          </p>
        </section>

        <section className="rounded-3xl border-2 border-slate-900 bg-white p-5">
          <h2 className="text-xl font-black text-slate-950">Live Session (Multimodal)</h2>
          <p className="mt-2 text-base text-slate-700">State: {liveStatusLabel(liveStatus)}</p>
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
              disabled={liveStatus !== "disconnected" && liveStatus !== "error"}
              className="rounded-2xl bg-slate-900 px-4 py-2 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-600"
            >
              Start Live
            </button>
            <button
              type="button"
              onClick={() => void sendLiveTextAndFrame()}
              disabled={!liveReady}
              className="rounded-2xl bg-sky-700 px-4 py-2 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-500"
            >
              Send Text + Current Frame
            </button>
            <button
              type="button"
              onClick={sendLiveAudioProbe}
              disabled={!liveReady}
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

          <div className="mt-4 max-h-52 space-y-2 overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-3">
            {liveEntries.length === 0 ? (
              <p className="text-sm text-slate-600">Live events will appear here.</p>
            ) : (
              liveEntries.map((entry, index) => (
                <p
                  key={`${entry.text}-${index}`}
                  className={`text-sm ${
                    entry.kind === "error"
                      ? "text-red-700"
                      : entry.kind === "model_text"
                        ? "text-emerald-700"
                        : entry.kind === "transcript"
                          ? "text-slate-800"
                          : "text-sky-700"
                  }`}
                >
                  {entry.time} {entry.kind}: {entry.text}
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
