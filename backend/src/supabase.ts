import crypto from "node:crypto";
import { AppConfig, PlanActionResponse, SandboxFixtureContext, SandboxRunEventRequest, SandboxRunStartRequest, SandboxRunStartResponse } from "./types";
import { getDeterministicFixtureRecords } from "./firestore";
import { safeErrorMessage } from "./utils";

function parseSeed(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const normalized = Math.floor(Math.abs(Number(value)));
  return normalized > 0 ? normalized : 1;
}

function normalizeToPool(seed: number, poolSize: number): number {
  return ((seed - 1) % poolSize) + 1;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export class SupabaseRepository {
  private runtimeReady = true;
  private lastError: string | null = null;

  constructor(private readonly config: AppConfig) {
    this.runtimeReady = this.isConfigured();
  }

  getDiagnostics() {
    return {
      provider: "supabase" as const,
      configured: this.isConfigured(),
      mode: this.isConfigured() ? "service_role_rest" : "disabled",
      runtimeReady: this.runtimeReady,
      lastError: this.lastError ?? undefined,
    };
  }

  markUnavailable(error: unknown): void {
    this.runtimeReady = false;
    this.lastError = safeErrorMessage(error);
  }

  private isConfigured(): boolean {
    return this.config.supabaseUrl.length > 0 && this.config.supabaseServiceRoleKey.length > 0;
  }

  private requireConfigured(): void {
    if (!this.isConfigured() || !this.runtimeReady) {
      throw new Error(this.lastError ?? "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY server-side.");
    }
  }

  private tableUrl(table: string, query = ""): string {
    const base = this.config.supabaseUrl.replace(/\/+$/, "");
    return `${base}/rest/v1/${table}${query}`;
  }

  private async request<T>(table: string, init: RequestInit & { query?: string } = {}): Promise<T> {
    this.requireConfigured();
    const headers = new Headers(init.headers);
    headers.set("apikey", this.config.supabaseServiceRoleKey);
    headers.set("Authorization", `Bearer ${this.config.supabaseServiceRoleKey}`);
    if (!headers.has("Content-Type") && init.body) {
      headers.set("Content-Type", "application/json");
    }
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }

    const response = await fetch(this.tableUrl(table, init.query), {
      ...init,
      headers,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase ${table} request failed with status ${response.status}: ${text.slice(0, 240)}`);
    }
    return text ? (JSON.parse(text) as T) : ([] as T);
  }

  async ensureDeterministicFixtures(): Promise<number> {
    const records = getDeterministicFixtureRecords();
    await this.request("sandbox_fixtures", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(
        records.map((record) => ({
          seed: record.seed,
          fixture: record.fixture,
          updated_at: new Date().toISOString(),
        })),
      ),
    });
    return records.length;
  }

  async getFixtureBySeed(seedInput: number | undefined): Promise<{ seed: number; fixture: SandboxFixtureContext }> {
    await this.ensureDeterministicFixtures();
    const requestedSeed = parseSeed(seedInput);
    const rows = await this.request<Array<{ seed: number; fixture: SandboxFixtureContext }>>("sandbox_fixtures", {
      method: "GET",
      query: "?select=seed,fixture&order=seed.asc",
    });
    if (rows.length === 0) {
      throw new Error("No sandbox fixtures are available in Supabase.");
    }
    const normalizedSeed = normalizeToPool(requestedSeed, rows.length);
    const selected = rows.find((row) => row.seed === normalizedSeed) ?? rows[0];
    return { seed: requestedSeed, fixture: selected.fixture };
  }

  async startSandboxRun(request: SandboxRunStartRequest): Promise<SandboxRunStartResponse> {
    const resolved = await this.getFixtureBySeed(request.seed);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await this.request("sandbox_runs", {
      method: "POST",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        id: runId,
        seed: resolved.fixture.seed,
        source: request.source ?? "sandbox",
        navigator_session_id: request.navigatorSessionId ?? null,
        fixture: resolved.fixture,
        created_at: startedAt,
      }),
    });
    return {
      runId,
      seed: resolved.seed,
      fixture: resolved.fixture,
      startedAt,
    };
  }

  async appendSandboxRunEvent(request: SandboxRunEventRequest): Promise<void> {
    await this.request("sandbox_run_events", {
      method: "POST",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        run_id: request.runId,
        step: request.step,
        event_type: request.eventType,
        metadata: request.metadata ?? {},
      }),
    });
  }

  async upsertNavigatorSession(sessionId: string, userGoal: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.request("navigator_sessions", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        id: sessionId,
        user_goal: userGoal,
        state: metadata ?? {},
        updated_at: new Date().toISOString(),
      }),
    });
  }

  async getNavigatorSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.request<Record<string, unknown>[]>("navigator_sessions", {
      method: "GET",
      query: `?id=eq.${encodeURIComponent(sessionId)}&select=id,user_goal,state,created_at,updated_at,expires_at&limit=1`,
    });
    const row = asObject(rows[0]);
    if (!row) {
      return null;
    }
    if (typeof row.expires_at === "string" && Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    return row;
  }

  async recordLiveEvent(sessionId: string, eventType: string, payload?: Record<string, unknown>): Promise<void> {
    await this.request("plan_action_events", {
      method: "POST",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        session_id: sessionId,
        request_summary: { eventType },
        response_summary: payload ?? {},
      }),
    });
  }

  async recordActionLog(
    sessionId: string,
    payload: {
      requestId: string;
      turnId?: string;
      userGoal: string;
      pageUrl?: string;
      pageTitle?: string;
      action: PlanActionResponse["action"];
      status: PlanActionResponse["status"];
      confidence: number;
      grounding: PlanActionResponse["grounding"];
    },
  ): Promise<void> {
    await this.request("plan_action_events", {
      method: "POST",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        session_id: sessionId,
        turn_id: payload.turnId ?? payload.requestId,
        request_summary: {
          requestId: payload.requestId,
          userGoalLength: payload.userGoal.length,
          pageUrl: payload.pageUrl,
          pageTitle: payload.pageTitle,
        },
        response_summary: {
          status: payload.status,
          actionType: payload.action.type,
          targetId: payload.action.targetId,
          confidence: payload.confidence,
          matchedElementCount: payload.grounding.matchedElementIds.length,
          matchedVisibleTextCount: payload.grounding.matchedVisibleText.length,
        },
      }),
    });
  }
}
