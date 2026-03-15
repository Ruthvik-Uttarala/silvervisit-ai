import type {
  HealthResponse,
  PlanActionRequest,
  PlanActionResponse,
  SandboxFixtureContext,
  SandboxRunStartResponse,
  SessionStartRequest,
  SessionStartResponse,
} from "./types";

const DEFAULT_BACKEND_BASE_URL = "http://localhost:8080";

export function getBackendBaseUrl() {
  const configured = import.meta.env.VITE_BACKEND_BASE_URL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_BACKEND_BASE_URL;
}

export function getBackendWsUrl() {
  const httpUrl = getBackendBaseUrl();
  if (httpUrl.startsWith("https://")) {
    return `wss://${httpUrl.slice("https://".length)}`;
  }
  if (httpUrl.startsWith("http://")) {
    return `ws://${httpUrl.slice("http://".length)}`;
  }
  return `ws://${httpUrl}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(errorBody?.error ?? errorBody?.message ?? `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

function buildHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Request-Id": crypto.randomUUID(),
  };
}

export async function startSession(payload: SessionStartRequest): Promise<SessionStartResponse> {
  const response = await fetch(`${getBackendBaseUrl()}/api/session/start`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });

  return parseJsonResponse<SessionStartResponse>(response);
}

export async function planAction(payload: PlanActionRequest): Promise<PlanActionResponse> {
  const response = await fetch(`${getBackendBaseUrl()}/api/plan-action`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });

  return parseJsonResponse<PlanActionResponse>(response);
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch(`${getBackendBaseUrl()}/health`, {
    method: "GET",
    headers: {
      "X-Request-Id": crypto.randomUUID(),
    },
  });
  return parseJsonResponse<HealthResponse>(response);
}

export async function getSandboxFixture(seed?: number): Promise<{ seed: number; fixture: SandboxFixtureContext }> {
  const search = typeof seed === "number" && Number.isFinite(seed) ? `?seed=${Math.floor(Math.abs(seed))}` : "";
  const response = await fetch(`${getBackendBaseUrl()}/api/sandbox/fixture${search}`, {
    method: "GET",
    headers: {
      "X-Request-Id": crypto.randomUUID(),
    },
  });
  return parseJsonResponse<{ seed: number; fixture: SandboxFixtureContext }>(response);
}

export async function startSandboxRun(payload: {
  seed?: number;
  source: "sandbox" | "extension";
  navigatorSessionId?: string;
}): Promise<SandboxRunStartResponse> {
  const response = await fetch(`${getBackendBaseUrl()}/api/sandbox/run/start`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse<SandboxRunStartResponse>(response);
}

export async function postSandboxRunEvent(payload: {
  runId: string;
  step: string;
  eventType: string;
  metadata?: Record<string, unknown>;
}): Promise<{ ok: boolean }> {
  const response = await fetch(`${getBackendBaseUrl()}/api/sandbox/run/event`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse<{ ok: boolean }>(response);
}
