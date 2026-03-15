import { useEffect, useMemo, useState } from "react";

type FlowStep =
  | "login"
  | "appointments"
  | "details"
  | "camera"
  | "microphone"
  | "device-test"
  | "waiting-room"
  | "joined-call";

interface DemoFixture {
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
}

const STEP_ORDER: FlowStep[] = [
  "login",
  "appointments",
  "details",
  "camera",
  "microphone",
  "device-test",
  "waiting-room",
  "joined-call",
];

const STEP_LABELS: Record<FlowStep, string> = {
  login: "Login",
  appointments: "Appointments",
  details: "Appointment Details",
  camera: "Camera",
  microphone: "Microphone",
  "device-test": "Device Test",
  "waiting-room": "Waiting Room",
  "joined-call": "Joined Call",
};

const NEXT_STEP: Record<FlowStep, FlowStep | null> = {
  login: "appointments",
  appointments: "details",
  details: "camera",
  camera: "microphone",
  microphone: "device-test",
  "device-test": "waiting-room",
  "waiting-room": "joined-call",
  "joined-call": null,
};

const FIXTURE_SEED_QUERY_PARAM = "seed";
const FIXTURE_SEED_STORAGE_KEY = "silvervisit:sandbox-seed";
const DEFAULT_SEED = 1;
const DEFAULT_BACKEND_BASE_URL = "http://localhost:8080";

function getBackendBaseUrl(): string {
  const configured = import.meta.env.VITE_BACKEND_BASE_URL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_BACKEND_BASE_URL;
}

function stepLabel(step: FlowStep) {
  return STEP_LABELS[step];
}

function normalizeSeed(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const integer = Math.floor(Math.abs(parsed));
  if (integer <= 0) {
    return null;
  }
  return integer;
}

function resolveInitialSeed(): number {
  const url = new URL(window.location.href);
  const seedFromUrl = normalizeSeed(url.searchParams.get(FIXTURE_SEED_QUERY_PARAM));
  if (seedFromUrl) {
    return seedFromUrl;
  }

  const seedFromStorage = normalizeSeed(window.localStorage.getItem(FIXTURE_SEED_STORAGE_KEY));
  if (seedFromStorage) {
    return seedFromStorage;
  }

  return DEFAULT_SEED;
}

function persistSeed(seed: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set(FIXTURE_SEED_QUERY_PARAM, String(seed));
  window.history.replaceState({}, "", url.toString());
  window.localStorage.setItem(FIXTURE_SEED_STORAGE_KEY, String(seed));
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export default function App() {
  const [seed, setSeed] = useState<number>(() => resolveInitialSeed());
  const [step, setStep] = useState<FlowStep>("login");
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [password, setPassword] = useState("");
  const [deviceNote, setDeviceNote] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [fixture, setFixture] = useState<DemoFixture | null>(null);
  const [isLoadingFixture, setIsLoadingFixture] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    persistSeed(seed);
  }, [seed]);

  const initializeRun = async (nextSeed: number) => {
    setIsLoadingFixture(true);
    setLoadError(null);
    try {
      const response = await fetch(`${getBackendBaseUrl()}/api/sandbox/run/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          seed: nextSeed,
          source: "sandbox",
        }),
      });
      const payload = await parseJsonResponse<{
        runId: string;
        seed: number;
        fixture: DemoFixture;
      }>(response);
      setRunId(payload.runId);
      setFixture(payload.fixture);
      setStep("login");
      setFullName("");
      setDob("");
      setPassword("");
      setDeviceNote("");
    } catch (error) {
      setFixture(null);
      setRunId(null);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingFixture(false);
    }
  };

  useEffect(() => {
    void initializeRun(seed);
  }, [seed]);

  const progress = useMemo(() => {
    const currentIndex = STEP_ORDER.indexOf(step);
    return `${currentIndex + 1} / ${STEP_ORDER.length}`;
  }, [step]);

  const canLogin =
    fixture !== null &&
    normalizeText(fullName) === normalizeText(fixture.patientName) &&
    normalizeText(dob) === normalizeText(fixture.patientDob) &&
    password.trim() === fixture.loginSecret;

  const appendRunEvent = async (eventStep: FlowStep, eventType: string, metadata?: Record<string, unknown>) => {
    if (!runId) {
      return;
    }
    try {
      await fetch(`${getBackendBaseUrl()}/api/sandbox/run/event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          runId,
          step: eventStep,
          eventType,
          metadata,
        }),
      });
    } catch {
      // Best-effort run evidence logging.
    }
  };

  const transitionStep = (target: FlowStep) => {
    setStep((current) => {
      if (NEXT_STEP[current] !== target) {
        return current;
      }
      void appendRunEvent(target, "step_transition", { from: current, to: target });
      return target;
    });
  };

  const resetDemoFlow = () => {
    setSeed((current) => current + 1);
  };

  if (isLoadingFixture) {
    return (
      <main className="min-h-screen bg-slate-100 text-slate-900">
        <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center px-5 py-8 lg:px-10">
          <section className="w-full rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-2xl font-bold text-slate-950">Loading deterministic fixture from backend...</h1>
            <p className="mt-2 text-base text-slate-700">Connecting to Firestore-backed sandbox data.</p>
          </section>
        </div>
      </main>
    );
  }

  if (loadError || !fixture) {
    return (
      <main className="min-h-screen bg-slate-100 text-slate-900">
        <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center px-5 py-8 lg:px-10">
          <section className="w-full rounded-3xl border border-red-200 bg-white p-6 shadow-sm">
            <h1 className="text-2xl font-bold text-red-800">Sandbox data unavailable</h1>
            <p className="mt-2 text-base text-slate-700">
              The backend Firestore route is required for this demo. Error: {loadError ?? "Unknown error"}
            </p>
            <button
              type="button"
              onClick={() => void initializeRun(seed)}
              className="mt-4 rounded-2xl bg-slate-900 px-5 py-3 text-lg font-bold text-white"
            >
              Retry Backend Fixture Load
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-5 py-8 lg:px-10">
        <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-sky-700">SilverVisit Telehealth Sandbox</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">Telehealth Check-In Demo Flow</h1>
          <p className="mt-2 text-lg text-slate-700">
            Firestore-backed deterministic path with stable actionable IDs and seeded visible persona variation.
          </p>
          <div className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-base text-slate-800" id="flow-progress-label">
            Progress: {progress} ({stepLabel(step)})
          </div>
          <div className="mt-2 rounded-2xl bg-slate-100 px-4 py-2 text-sm text-slate-700" id="fixture-seed-label">
            Fixture seed: {seed} | Fixture ID: {fixture.fixtureId}
          </div>
        </header>

        {step === "login" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-login-card">
            <h2 className="text-2xl font-bold text-slate-950" id="login-step-title">
              Sign in to your patient portal
            </h2>
            <p className="mt-2 text-base text-slate-700">
              Welcome {fixture.patientName}. Enter your information to continue to your appointment dashboard.
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Deterministic demo credentials for this seed: DOB {fixture.patientDob}, password {fixture.loginSecret}
            </p>

            <div className="mt-5 grid gap-4">
              <label className="text-sm font-semibold text-slate-700" htmlFor="login-full-name-input">
                Full name
              </label>
              <input
                id="login-full-name-input"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="Enter full name"
                className="rounded-xl border border-slate-300 px-4 py-3 text-lg"
              />

              <label className="text-sm font-semibold text-slate-700" htmlFor="login-dob-input">
                Date of birth
              </label>
              <input
                id="login-dob-input"
                value={dob}
                onChange={(event) => setDob(event.target.value)}
                placeholder="MM/DD/YYYY"
                className="rounded-xl border border-slate-300 px-4 py-3 text-lg"
              />

              <label className="text-sm font-semibold text-slate-700" htmlFor="login-password-input">
                Password
              </label>
              <input
                id="login-password-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter password"
                className="rounded-xl border border-slate-300 px-4 py-3 text-lg"
              />

              <button
                id="login-continue-btn"
                type="button"
                onClick={() => transitionStep("appointments")}
                disabled={!canLogin}
                className="mt-2 rounded-2xl bg-sky-700 px-5 py-3 text-lg font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                Continue to Appointments
              </button>

              <div id="login-status-text" role="status" aria-live="polite" className="text-sm text-slate-600">
                {canLogin
                  ? "Credentials matched. You can continue to appointments."
                  : "Enter the seeded full name, date of birth, and password to continue."}
              </div>
            </div>
          </section>
        )}

        {step === "appointments" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-appointments-card">
            <h2 className="text-2xl font-bold text-slate-950" id="appointments-step-title">
              Upcoming appointments
            </h2>
            <p className="mt-2 text-base text-slate-700">Select the telehealth appointment to continue.</p>

            <article className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-5" id="appointment-card-main">
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{fixture.appointmentTimeText}</p>
              <h3 className="mt-1 text-xl font-bold text-slate-950">
                {fixture.doctorName} - {fixture.appointmentType}
              </h3>
              <p className="mt-1 text-base text-slate-700">{fixture.clinicLabel}</p>
              <button
                id="open-appointment-details-btn"
                type="button"
                onClick={() => transitionStep("details")}
                className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-base font-semibold text-white"
              >
                Open Appointment Details
              </button>
            </article>
          </section>
        )}

        {step === "details" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-details-card">
            <h2 className="text-2xl font-bold text-slate-950" id="details-step-title">
              Appointment details
            </h2>
            <p className="mt-2 text-base text-slate-700">Complete check-in and join the visit when ready.</p>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-base text-slate-700" id="details-checklist-list">
              {fixture.detailsChecklist.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <button
              id="join-visit-btn"
              type="button"
              onClick={() => transitionStep("camera")}
              className="mt-5 rounded-2xl bg-sky-700 px-5 py-3 text-lg font-bold text-white"
            >
              Join Video Visit
            </button>
          </section>
        )}

        {step === "camera" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-camera-card">
            <h2 className="text-2xl font-bold text-slate-950" id="camera-step-title">
              Camera permission check
            </h2>
            <p className="mt-2 text-base text-slate-700">
              Allow camera to continue. This remains a deterministic, judge-safe portal step.
            </p>
            <button
              id="camera-allow-btn"
              type="button"
              onClick={() => transitionStep("microphone")}
              className="mt-5 rounded-2xl bg-slate-900 px-5 py-3 text-lg font-bold text-white"
            >
              Allow Camera
            </button>
          </section>
        )}

        {step === "microphone" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-microphone-card">
            <h2 className="text-2xl font-bold text-slate-950" id="microphone-step-title">
              Microphone permission check
            </h2>
            <p className="mt-2 text-base text-slate-700">
              Allow microphone to continue. This remains a deterministic, judge-safe portal step.
            </p>
            <button
              id="microphone-allow-btn"
              type="button"
              onClick={() => transitionStep("device-test")}
              className="mt-5 rounded-2xl bg-slate-900 px-5 py-3 text-lg font-bold text-white"
            >
              Allow Microphone
            </button>
          </section>
        )}

        {step === "device-test" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-device-test-card">
            <h2 className="text-2xl font-bold text-slate-950" id="device-test-step-title">
              Pre-call device test
            </h2>
            <p className="mt-2 text-base text-slate-700">Type any quick note and continue to the waiting room.</p>
            <label htmlFor="device-note-input" className="mt-4 block text-sm font-semibold text-slate-700">
              Device test note
            </label>
            <input
              id="device-note-input"
              value={deviceNote}
              onChange={(event) => setDeviceNote(event.target.value)}
              placeholder="Example: I can hear and see clearly"
              className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg"
            />
            <button
              id="finish-device-test-btn"
              type="button"
              onClick={() => transitionStep("waiting-room")}
              className="mt-5 rounded-2xl bg-sky-700 px-5 py-3 text-lg font-bold text-white"
            >
              Continue to Waiting Room
            </button>
          </section>
        )}

        {step === "waiting-room" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-waiting-room-card">
            <h2 className="text-2xl font-bold text-slate-950" id="waiting-room-step-title">
              Waiting room
            </h2>
            <p className="mt-2 text-base text-slate-700">You are checked in. Enter the call when the clinician is ready.</p>
            <div id="waiting-room-status-text" role="status" className="mt-4 rounded-xl bg-amber-100 px-4 py-3 text-base text-amber-900">
              {fixture.waitingRoomState}
            </div>
            <button
              id="enter-call-btn"
              type="button"
              onClick={() => transitionStep("joined-call")}
              className="mt-5 rounded-2xl bg-emerald-700 px-5 py-3 text-lg font-bold text-white"
            >
              Enter Call
            </button>
          </section>
        )}

        {step === "joined-call" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-joined-call-card">
            <h2 className="text-2xl font-bold text-slate-950" id="joined-call-step-title">
              You have joined the visit
            </h2>
            <p className="mt-2 text-base text-slate-700">The telehealth flow is complete for this demo.</p>
            <div id="joined-call-status-text" role="status" className="mt-4 rounded-xl bg-emerald-100 px-4 py-3 text-base text-emerald-900">
              {fixture.clinicianReadyState}
            </div>
            <button
              id="restart-demo-btn"
              type="button"
              onClick={resetDemoFlow}
              className="mt-5 rounded-2xl bg-slate-900 px-5 py-3 text-lg font-bold text-white"
            >
              Restart Demo Flow
            </button>
          </section>
        )}

        {step !== "joined-call" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
            <p id="flow-tip-text">Tip: the SilverVisit extension should run one grounded action at a time on this page.</p>
          </section>
        )}
      </div>
    </main>
  );
}
