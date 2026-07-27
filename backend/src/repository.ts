import { AppConfig, PlanActionResponse, SandboxFixtureContext, SandboxRunEventRequest, SandboxRunStartRequest, SandboxRunStartResponse } from "./types";
import { FirestoreRepository, getFirestoreRepository } from "./firestore";
import { SupabaseRepository } from "./supabase";

export interface RepositoryDiagnostics {
  provider: "supabase" | "firestore";
  configured: boolean;
  mode: string;
  runtimeReady: boolean;
  lastError?: string;
}

export interface AppRepository {
  getDiagnostics(): RepositoryDiagnostics;
  markUnavailable(error: unknown): void;
  ensureDeterministicFixtures(): Promise<number>;
  getFixtureBySeed(seedInput: number | undefined): Promise<{ seed: number; fixture: SandboxFixtureContext }>;
  startSandboxRun(request: SandboxRunStartRequest): Promise<SandboxRunStartResponse>;
  appendSandboxRunEvent(request: SandboxRunEventRequest): Promise<void>;
  upsertNavigatorSession(sessionId: string, userGoal: string, metadata?: Record<string, unknown>): Promise<void>;
  getNavigatorSession(sessionId: string): Promise<Record<string, unknown> | null>;
  recordLiveEvent(sessionId: string, eventType: string, payload?: Record<string, unknown>): Promise<void>;
  recordActionLog(
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
  ): Promise<void>;
}

class FirestoreRepositoryAdapter implements AppRepository {
  constructor(private readonly repository: FirestoreRepository) {}

  getDiagnostics(): RepositoryDiagnostics {
    const diagnostics = this.repository.getDiagnostics();
    return {
      provider: "firestore",
      configured: diagnostics.configured,
      mode: diagnostics.mode,
      runtimeReady: diagnostics.runtimeReady,
      lastError: diagnostics.lastError,
    };
  }

  markUnavailable(error: unknown): void {
    this.repository.markUnavailable(error);
  }

  ensureDeterministicFixtures(): Promise<number> {
    return this.repository.ensureDeterministicFixtures();
  }

  getFixtureBySeed(seedInput: number | undefined): Promise<{ seed: number; fixture: SandboxFixtureContext }> {
    return this.repository.getFixtureBySeed(seedInput);
  }

  startSandboxRun(request: SandboxRunStartRequest): Promise<SandboxRunStartResponse> {
    return this.repository.startSandboxRun(request);
  }

  appendSandboxRunEvent(request: SandboxRunEventRequest): Promise<void> {
    return this.repository.appendSandboxRunEvent(request);
  }

  upsertNavigatorSession(sessionId: string, userGoal: string, metadata?: Record<string, unknown>): Promise<void> {
    return this.repository.upsertNavigatorSession(sessionId, userGoal, metadata);
  }

  getNavigatorSession(sessionId: string): Promise<Record<string, unknown> | null> {
    return this.repository.getNavigatorSession(sessionId);
  }

  recordLiveEvent(sessionId: string, eventType: string, payload?: Record<string, unknown>): Promise<void> {
    return this.repository.recordLiveEvent(sessionId, eventType, payload);
  }

  recordActionLog(sessionId: string, payload: Parameters<AppRepository["recordActionLog"]>[1]): Promise<void> {
    return this.repository.recordActionLog(sessionId, payload);
  }
}

let cachedRepository: AppRepository | null = null;
let cachedKey = "";

export function getRepository(config: AppConfig): AppRepository {
  const key = [
    config.persistenceProvider,
    config.supabaseUrl,
    config.supabaseServiceRoleKey ? "service-role-configured" : "service-role-missing",
    config.enableFirestore ? "firestore-on" : "firestore-off",
    config.googleCloudProject,
    config.firestoreCollectionPrefix,
    process.env.FIRESTORE_EMULATOR_HOST ?? "",
  ].join(":");

  if (cachedRepository && cachedKey === key) {
    return cachedRepository;
  }

  cachedRepository =
    config.persistenceProvider === "firestore"
      ? new FirestoreRepositoryAdapter(getFirestoreRepository(config))
      : new SupabaseRepository(config);
  cachedKey = key;
  return cachedRepository;
}
