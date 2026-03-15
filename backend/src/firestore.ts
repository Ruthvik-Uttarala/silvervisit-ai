import crypto from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import {
  AppConfig,
  PlanActionResponse,
  SandboxFixtureContext,
  SandboxRunEventRequest,
  SandboxRunStartRequest,
  SandboxRunStartResponse,
} from "./types";

export type FirestoreMode = "emulator" | "production" | "disabled";

const DEFAULT_FIXTURES: Omit<SandboxFixtureContext, "seed" | "fixtureId">[] = [
  {
    patientName: "Avery Johnson",
    patientDob: "04/11/1952",
    loginSecret: "Avery-Visit-2044",
    doctorName: "Dr. Elena Carter",
    appointmentType: "Follow-up Visit",
    clinicLabel: "SilverVisit Video Room",
    waitingRoomState: "Waiting for Dr. Elena Carter to join.",
    clinicianReadyState: "Dr. Elena Carter has joined and is ready.",
    appointmentTimeText: "Today at 2:30 PM",
    visitTitle: "Follow-up Visit",
    detailsChecklist: ["Insurance on file", "Consent received", "Estimated wait time: 3 minutes"],
  },
  {
    patientName: "Miguel Thompson",
    patientDob: "12/03/1950",
    loginSecret: "Miguel-Clinic-5501",
    doctorName: "Dr. Naomi Patel",
    appointmentType: "Primary Care Check-in",
    clinicLabel: "SilverVisit Virtual Clinic",
    waitingRoomState: "Waiting for Dr. Naomi Patel to join.",
    clinicianReadyState: "Dr. Naomi Patel is ready for the visit.",
    appointmentTimeText: "Today at 3:15 PM",
    visitTitle: "Primary Care Check-in",
    detailsChecklist: ["Insurance on file", "Consent received", "Estimated wait time: 5 minutes"],
  },
  {
    patientName: "Harper Lewis",
    patientDob: "08/28/1956",
    loginSecret: "Harper-Checkin-8820",
    doctorName: "Dr. Victor Alvarez",
    appointmentType: "Medication Review",
    clinicLabel: "SilverVisit Care Portal",
    waitingRoomState: "Waiting for Dr. Victor Alvarez to join.",
    clinicianReadyState: "Dr. Victor Alvarez has entered the room.",
    appointmentTimeText: "Today at 4:05 PM",
    visitTitle: "Medication Review",
    detailsChecklist: ["Insurance on file", "Consent received", "Estimated wait time: 4 minutes"],
  },
  {
    patientName: "Riley Garcia",
    patientDob: "01/19/1949",
    loginSecret: "Riley-Ready-4402",
    doctorName: "Dr. Lena Cho",
    appointmentType: "Care Plan Follow-up",
    clinicLabel: "SilverVisit Telehealth Suite",
    waitingRoomState: "Waiting for Dr. Lena Cho to join.",
    clinicianReadyState: "Dr. Lena Cho is connected and ready.",
    appointmentTimeText: "Today at 1:45 PM",
    visitTitle: "Care Plan Follow-up",
    detailsChecklist: ["Insurance on file", "Consent received", "Estimated wait time: 2 minutes"],
  },
  {
    patientName: "Jordan Kim",
    patientDob: "07/02/1954",
    loginSecret: "Jordan-Portal-7314",
    doctorName: "Dr. Priya Raman",
    appointmentType: "Wellness Check",
    clinicLabel: "SilverVisit Remote Visit",
    waitingRoomState: "Waiting for Dr. Priya Raman to join.",
    clinicianReadyState: "Dr. Priya Raman is ready for your visit.",
    appointmentTimeText: "Today at 11:20 AM",
    visitTitle: "Wellness Check",
    detailsChecklist: ["Insurance on file", "Consent received", "Estimated wait time: 6 minutes"],
  },
];

interface FirestoreDiagnostics {
  configured: boolean;
  mode: FirestoreMode;
  runtimeReady: boolean;
  lastError?: string;
}

function parseSeed(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const normalized = Math.floor(Math.abs(value as number));
  return normalized > 0 ? normalized : 1;
}

function normalizeToPool(seed: number, poolSize: number): number {
  if (poolSize <= 0) {
    return 1;
  }
  return ((seed - 1) % poolSize) + 1;
}

export function getFirestoreDiagnostics(config: AppConfig): FirestoreDiagnostics {
  if (!config.enableFirestore) {
    return { configured: false, mode: "disabled", runtimeReady: false };
  }
  if ((process.env.FIRESTORE_EMULATOR_HOST ?? "").trim()) {
    return { configured: true, mode: "emulator", runtimeReady: true };
  }
  if (config.googleCloudProject.trim()) {
    return { configured: true, mode: "production", runtimeReady: true };
  }
  return { configured: false, mode: "disabled", runtimeReady: false };
}

function mapFixture(doc: Record<string, unknown>): SandboxFixtureContext | null {
  if (
    typeof doc.fixtureId !== "string" ||
    typeof doc.seed !== "number" ||
    typeof doc.patientName !== "string" ||
    typeof doc.patientDob !== "string" ||
    typeof doc.loginSecret !== "string" ||
    typeof doc.doctorName !== "string" ||
    typeof doc.appointmentType !== "string" ||
    typeof doc.clinicLabel !== "string" ||
    typeof doc.waitingRoomState !== "string" ||
    typeof doc.clinicianReadyState !== "string" ||
    typeof doc.appointmentTimeText !== "string" ||
    typeof doc.visitTitle !== "string"
  ) {
    return null;
  }
  const detailsChecklist = Array.isArray(doc.detailsChecklist)
    ? doc.detailsChecklist.filter((item): item is string => typeof item === "string")
    : [];
  return {
    fixtureId: doc.fixtureId,
    seed: doc.seed,
    patientName: doc.patientName,
    patientDob: doc.patientDob,
    loginSecret: doc.loginSecret,
    doctorName: doc.doctorName,
    appointmentType: doc.appointmentType,
    clinicLabel: doc.clinicLabel,
    waitingRoomState: doc.waitingRoomState,
    clinicianReadyState: doc.clinicianReadyState,
    appointmentTimeText: doc.appointmentTimeText,
    visitTitle: doc.visitTitle,
    detailsChecklist,
  };
}

export class FirestoreRepository {
  private readonly collectionPrefix: string;
  private readonly firestore: Firestore | null;
  private readonly diagnosticsBase: FirestoreDiagnostics;
  private runtimeReady = true;
  private lastError: string | null = null;

  constructor(private readonly config: AppConfig) {
    this.diagnosticsBase = getFirestoreDiagnostics(config);
    this.collectionPrefix = config.firestoreCollectionPrefix.trim();
    this.runtimeReady = this.diagnosticsBase.runtimeReady;
    if (!this.diagnosticsBase.configured) {
      this.firestore = null;
      return;
    }
    const projectId = config.googleCloudProject.trim() || "silvervisit-local";
    this.firestore = new Firestore({
  projectId,
  ignoreUndefinedProperties: true,
});

  }

  getDiagnostics(): FirestoreDiagnostics {
    return {
      configured: this.diagnosticsBase.configured && this.runtimeReady,
      mode: this.diagnosticsBase.mode,
      runtimeReady: this.runtimeReady,
      lastError: this.lastError ?? undefined,
    };
  }

  markUnavailable(error: unknown): void {
    this.runtimeReady = false;
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private requireFirestore(): Firestore {
    if (!this.firestore || !this.diagnosticsBase.configured || !this.runtimeReady) {
      throw new Error(
        this.lastError ??
          "Firestore is not configured. Set ENABLE_FIRESTORE=true and either FIRESTORE_EMULATOR_HOST or GOOGLE_CLOUD_PROJECT.",
      );
    }
    return this.firestore;
  }

  private collectionName(name: string): string {
    if (!this.collectionPrefix) {
      return name;
    }
    return `${this.collectionPrefix}_${name}`;
  }

  async ensureDeterministicFixtures(): Promise<number> {
    const firestore = this.requireFirestore();
    const now = new Date().toISOString();
    const batch = firestore.batch();
    const collection = firestore.collection(this.collectionName("sandboxFixtures"));
    for (let i = 0; i < DEFAULT_FIXTURES.length; i += 1) {
      const seed = i + 1;
      const fixtureId = `fixture-${seed}`;
      const ref = collection.doc(fixtureId);
      batch.set(
        ref,
        {
          fixtureId,
          seed,
          ...DEFAULT_FIXTURES[i],
          updatedAt: now,
          createdAt: now,
        },
        { merge: true },
      );
    }
    await batch.commit();
    return DEFAULT_FIXTURES.length;
  }

  async listFixtures(): Promise<SandboxFixtureContext[]> {
    const firestore = this.requireFirestore();
    const snapshot = await firestore.collection(this.collectionName("sandboxFixtures")).orderBy("seed", "asc").get();
    const items: SandboxFixtureContext[] = [];
    for (const doc of snapshot.docs) {
      const fixture = mapFixture(doc.data() as Record<string, unknown>);
      if (fixture) {
        items.push(fixture);
      }
    }
    return items;
  }

  async getFixtureBySeed(seedInput: number | undefined): Promise<{ seed: number; fixture: SandboxFixtureContext }> {
    let fixtures = await this.listFixtures();
    if (fixtures.length === 0) {
      await this.ensureDeterministicFixtures();
      fixtures = await this.listFixtures();
    }
    if (fixtures.length === 0) {
      throw new Error("No sandbox fixtures are available in Firestore.");
    }
    const requestedSeed = parseSeed(seedInput);
    const index = normalizeToPool(requestedSeed, fixtures.length) - 1;
    return {
      seed: requestedSeed,
      fixture: fixtures[index],
    };
  }

  async startSandboxRun(request: SandboxRunStartRequest): Promise<SandboxRunStartResponse> {
    const firestore = this.requireFirestore();
    const resolved = await this.getFixtureBySeed(request.seed);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await firestore
      .collection(this.collectionName("sandboxRuns"))
      .doc(runId)
      .set({
        runId,
        seed: resolved.seed,
        fixtureId: resolved.fixture.fixtureId,
        source: request.source ?? "sandbox",
        navigatorSessionId: request.navigatorSessionId ?? null,
        currentStep: "login",
        status: "active",
        createdAt: startedAt,
        updatedAt: startedAt,
      });
    return {
      runId,
      seed: resolved.seed,
      fixture: resolved.fixture,
      startedAt,
    };
  }

  async appendSandboxRunEvent(request: SandboxRunEventRequest): Promise<void> {
    const firestore = this.requireFirestore();
    const timestamp = new Date().toISOString();
    await firestore
      .collection(this.collectionName("sandboxRuns"))
      .doc(request.runId)
      .set(
        {
          updatedAt: timestamp,
          currentStep: request.step,
          lastEventType: request.eventType,
          lastEventMetadata: request.metadata ?? null,
        },
        { merge: true },
      );
  }

  async upsertNavigatorSession(
    sessionId: string,
    userGoal: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const firestore = this.requireFirestore();
    const timestamp = new Date().toISOString();
    await firestore
      .collection(this.collectionName("navigatorSessions"))
      .doc(sessionId)
      .set(
        {
          sessionId,
          userGoal,
          lastSeenAt: timestamp,
          updatedAt: timestamp,
          createdAt: timestamp,
          metadata: metadata ?? null,
        },
        { merge: true },
      );
  }

  async getNavigatorSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const firestore = this.requireFirestore();
    const doc = await firestore.collection(this.collectionName("navigatorSessions")).doc(sessionId).get();
    if (!doc.exists) {
      return null;
    }
    return doc.data() as Record<string, unknown>;
  }

  async recordLiveEvent(sessionId: string, eventType: string, payload?: Record<string, unknown>): Promise<void> {
    const firestore = this.requireFirestore();
    await firestore.collection(this.collectionName("liveEvents")).add({
      sessionId,
      eventType,
      payload: payload ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  async recordActionLog(
    sessionId: string,
    payload: {
      requestId: string;
      userGoal: string;
      pageUrl?: string;
      pageTitle?: string;
      action: PlanActionResponse["action"];
      status: PlanActionResponse["status"];
      confidence: number;
      grounding: PlanActionResponse["grounding"];
    },
  ): Promise<void> {
    const firestore = this.requireFirestore();
    await firestore.collection(this.collectionName("actionLogs")).add({
      sessionId,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }
}

let cachedRepository: FirestoreRepository | null = null;
let cachedKey = "";

export function getFirestoreRepository(config: AppConfig): FirestoreRepository {
  const key = [
    config.enableFirestore ? "1" : "0",
    config.googleCloudProject,
    config.firestoreCollectionPrefix,
    process.env.FIRESTORE_EMULATOR_HOST ?? "",
  ].join(":");
  if (cachedRepository && cachedKey === key) {
    return cachedRepository;
  }
  cachedRepository = new FirestoreRepository(config);
  cachedKey = key;
  return cachedRepository;
}
