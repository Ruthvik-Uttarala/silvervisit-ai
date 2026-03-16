
import { useCallback, useEffect, useMemo, useState } from "react";

type AppointmentStatus =
  | "upcoming"
  | "today"
  | "ready_to_join"
  | "waiting_room"
  | "completed"
  | "past"
  | "canceled"
  | "rescheduled";

type PortalLifecycleState =
  | "pre_check_in"
  | "echeckin_in_progress"
  | "device_setup"
  | "waiting_room"
  | "provider_ready"
  | "joined";

type PortalSection =
  | "login"
  | "dashboard"
  | "upcoming"
  | "past"
  | "appointment_details"
  | "echeckin"
  | "device_setup"
  | "waiting_room"
  | "reports_results"
  | "notes_avs"
  | "messages"
  | "message_thread"
  | "prescriptions"
  | "referrals"
  | "help"
  | "after_visit"
  | "joined";

interface SandboxAppointment {
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

interface SandboxPreVisitTask {
  taskId: string;
  label: string;
  required: boolean;
  completed: boolean;
  section: string;
}

interface SandboxDeviceCheck {
  checkId: string;
  label: string;
  required: boolean;
  passed: boolean;
}

interface SandboxSupportPath {
  pathId: string;
  label: string;
  description: string;
  actionHint: string;
}

interface SandboxPastVisitSummary {
  visitId: string;
  completedDateTime: string;
  providerName: string;
  specialty: string;
  summaryTitle: string;
  summarySnippet: string;
}

interface SandboxReportResult {
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

interface SandboxNoteAvs {
  noteId: string;
  appointmentId: string;
  completedDateTime: string;
  providerName: string;
  specialty: string;
  topic: string;
  summaryTitle: string;
  summarySnippet: string;
}

interface SandboxMessageThread {
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

interface SandboxPrescription {
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

interface SandboxReferral {
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

interface SandboxFixtureContext {
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

interface SandboxRunStartResponse {
  runId: string;
  seed: number;
  fixture: SandboxFixtureContext;
}

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_SEED = 1;
const FIXTURE_SEED_QUERY_PARAM = "seed";
const FIXTURE_SEED_STORAGE_KEY = "silvervisit:sandbox-seed";

function getBackendBaseUrl(): string {
  const configured = import.meta.env.VITE_BACKEND_BASE_URL?.trim();
  return configured || DEFAULT_BACKEND_BASE_URL;
}

function normalizeSeed(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const normalized = Math.floor(Math.abs(n));
  return normalized > 0 ? normalized : null;
}

function resolveInitialSeed(): number {
  const url = new URL(window.location.href);
  const fromUrl = normalizeSeed(url.searchParams.get(FIXTURE_SEED_QUERY_PARAM));
  if (fromUrl) return fromUrl;
  const fromStorage = normalizeSeed(window.localStorage.getItem(FIXTURE_SEED_STORAGE_KEY));
  return fromStorage ?? DEFAULT_SEED;
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

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function lifecycleLabel(value: PortalLifecycleState): string {
  if (value === "pre_check_in") return "Pre Check-In";
  if (value === "echeckin_in_progress") return "eCheck-In In Progress";
  if (value === "device_setup") return "Device Setup";
  if (value === "waiting_room") return "Waiting Room";
  if (value === "provider_ready") return "Provider Ready";
  return "Joined";
}

function statusLabel(status: AppointmentStatus, joinableNow: boolean): string {
  if (joinableNow) return "Ready to Join";
  if (status === "today") return "Today";
  if (status === "upcoming") return "Upcoming";
  if (status === "completed") return "Completed";
  if (status === "past") return "Past";
  if (status === "canceled") return "Canceled";
  if (status === "rescheduled") return "Rescheduled";
  return "Waiting Room";
}

function isPastLike(status: AppointmentStatus): boolean {
  return status === "past" || status === "completed";
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export default function App() {
  const [seed, setSeed] = useState<number>(() => resolveInitialSeed());
  const [fixture, setFixture] = useState<SandboxFixtureContext | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [isLoadingFixture, setIsLoadingFixture] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [section, setSection] = useState<PortalSection>("login");
  const [portalState, setPortalState] = useState<PortalLifecycleState>("pre_check_in");
  const [selectedAppointmentId, setSelectedAppointmentId] = useState<string | null>(null);
  const [selectedPastVisitId, setSelectedPastVisitId] = useState<string | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedPrescriptionId, setSelectedPrescriptionId] = useState<string | null>(null);
  const [selectedReferralId, setSelectedReferralId] = useState<string | null>(null);
  const [activeSupportPathId, setActiveSupportPathId] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [password, setPassword] = useState("");
  const [taskCompletion, setTaskCompletion] = useState<Record<string, boolean>>({});
  const [deviceCompletion, setDeviceCompletion] = useState<Record<string, boolean>>({});
  const [providerReady, setProviderReady] = useState(false);
  const [eventNote, setEventNote] = useState("No recent event.");

  useEffect(() => {
    persistSeed(seed);
  }, [seed]);

  const appendRunEvent = useCallback(
    async (step: string, eventType: string, metadata?: Record<string, unknown>) => {
      if (!runId) return;
      try {
        await fetch(`${getBackendBaseUrl()}/api/sandbox/run/event`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": crypto.randomUUID(),
          },
          body: JSON.stringify({
            runId,
            step,
            eventType,
            metadata,
          }),
        });
      } catch {
        // Best-effort event logging.
      }
    },
    [runId],
  );

  const revealElementById = useCallback((elementId: string) => {
    requestAnimationFrame(() => {
      const target = document.getElementById(elementId);
      if (!target) {
        return;
      }
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, []);

  const navigate = useCallback(
    (next: PortalSection, eventType = "navigate", metadata?: Record<string, unknown>) => {
      setSection(next);
      void appendRunEvent(next, eventType, metadata);
    },
    [appendRunEvent],
  );

  const setLifecycle = useCallback(
    (next: PortalLifecycleState) => {
      setPortalState(next);
      void appendRunEvent(section, "portal_state", { portalState: next });
    },
    [appendRunEvent, section],
  );

  const initializeRun = useCallback(async (nextSeed: number) => {
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
      const payload = await parseJsonResponse<SandboxRunStartResponse>(response);
      setSeed(payload.seed);
      setFixture(payload.fixture);
      setRunId(payload.runId);
      setSection("login");
      setPortalState(payload.fixture.portalState);
      setProviderReady(payload.fixture.portalState === "provider_ready" || payload.fixture.portalState === "joined");
      setSelectedAppointmentId(payload.fixture.appointments[0]?.appointmentId ?? null);
      setSelectedPastVisitId(payload.fixture.pastVisitSummaries[0]?.visitId ?? null);
      setSelectedReportId(payload.fixture.reportsResults[0]?.resultId ?? null);
      setSelectedNoteId(payload.fixture.notesAvs[0]?.noteId ?? null);
      setSelectedThreadId(payload.fixture.messageThreads[0]?.threadId ?? null);
      setSelectedPrescriptionId(payload.fixture.prescriptions[0]?.prescriptionId ?? null);
      setSelectedReferralId(payload.fixture.referrals[0]?.referralId ?? null);
      setActiveSupportPathId(null);
      setTaskCompletion(
        payload.fixture.preVisitTasks.reduce<Record<string, boolean>>((acc, task) => {
          acc[task.taskId] = task.completed;
          return acc;
        }, {}),
      );
      setDeviceCompletion(
        payload.fixture.deviceChecks.reduce<Record<string, boolean>>((acc, check) => {
          acc[check.checkId] = check.passed;
          return acc;
        }, {}),
      );
      setFullName("");
      setDob("");
      setPassword("");
      setEventNote("Deterministic fixture loaded from backend.");
    } catch (error) {
      setFixture(null);
      setRunId(null);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingFixture(false);
    }
  }, []);

  useEffect(() => {
    void initializeRun(seed);
  }, [initializeRun, seed]);

  const appointmentsSorted = useMemo(
    () => [...(fixture?.appointments ?? [])].sort((a, b) => Date.parse(a.scheduledDateTime) - Date.parse(b.scheduledDateTime)),
    [fixture],
  );
  const upcomingAppointments = useMemo(
    () => appointmentsSorted.filter((appointment) => !isPastLike(appointment.status)),
    [appointmentsSorted],
  );
  const pastAppointments = useMemo(
    () => appointmentsSorted.filter((appointment) => isPastLike(appointment.status)),
    [appointmentsSorted],
  );
  const selectedAppointment = useMemo(
    () => appointmentsSorted.find((appointment) => appointment.appointmentId === selectedAppointmentId) ?? null,
    [appointmentsSorted, selectedAppointmentId],
  );
  const joinableAppointment = useMemo(
    () => appointmentsSorted.find((appointment) => appointment.joinableNow && !isPastLike(appointment.status)) ?? null,
    [appointmentsSorted],
  );
  const selectedThread = useMemo(
    () => fixture?.messageThreads.find((item) => item.threadId === selectedThreadId) ?? fixture?.messageThreads[0] ?? null,
    [fixture, selectedThreadId],
  );

  const loginMatched = Boolean(
    fixture &&
      normalizeText(fullName) === normalizeText(fixture.patientName) &&
      normalizeText(dob) === normalizeText(fixture.patientDob) &&
      password.trim() === fixture.loginSecret,
  );
  const tasksDone = useMemo(
    () => fixture?.preVisitTasks.every((task) => !task.required || Boolean(taskCompletion[task.taskId])) ?? false,
    [fixture, taskCompletion],
  );
  const devicesDone = useMemo(
    () => fixture?.deviceChecks.every((check) => !check.required || Boolean(deviceCompletion[check.checkId])) ?? false,
    [deviceCompletion, fixture],
  );
  const canEnterWaiting = Boolean(selectedAppointment?.joinableNow && tasksDone && devicesDone);
  const canJoinCall = canEnterWaiting && providerReady && portalState === "provider_ready";

  const recommendedNext = useMemo(() => {
    if (section === "login") return "Sign in with the seeded credentials.";
    if (section === "reports_results") return "Open the result that matches your provider, topic, and time.";
    if (section === "notes_avs") return "Open notes tied to the correct completed visit.";
    if (section === "messages" || section === "message_thread") return "Open the right thread or compose a secure message.";
    if (section === "prescriptions") return "Open prescriptions linked to the intended visit topic.";
    if (section === "referrals") return "Open referrals from the matching provider and timeframe.";
    if (!selectedAppointment) return "Open an appointment card to continue.";
    if (portalState === "pre_check_in") return "Start eCheck-In on the correct appointment.";
    if (portalState === "echeckin_in_progress" && !tasksDone) return "Finish all required eCheck-In items, including below the fold.";
    if (portalState === "device_setup" && !devicesDone) return "Complete camera, microphone, and speaker tests.";
    if (portalState === "waiting_room" && !providerReady) return "Refresh provider status while waiting.";
    if (portalState === "provider_ready") return "Enter the call now.";
    return "Joined state reached. Review after-visit summary.";
  }, [devicesDone, portalState, providerReady, section, selectedAppointment, tasksDone]);

  const restartWithNextSeed = () => {
    setSeed((current) => current + 1);
  };

  if (isLoadingFixture) {
    return (
      <main className="min-h-screen bg-slate-100 p-8 text-slate-900">
        <h1 className="text-3xl font-black">Loading telehealth fixture...</h1>
      </main>
    );
  }

  if (loadError || !fixture) {
    return (
      <main className="min-h-screen bg-slate-100 p-8 text-slate-900">
        <h1 className="text-3xl font-black text-rose-900">Sandbox data unavailable</h1>
        <p className="mt-3 text-lg">Error: {loadError ?? "Unknown error"}</p>
        <button
          id="retry-fixture-load-btn"
          type="button"
          onClick={() => void initializeRun(seed)}
          className="mt-4 rounded-2xl bg-slate-900 px-5 py-3 text-lg font-bold text-white"
        >
          Retry
        </button>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#edf2ff] text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col gap-4 p-4 md:p-7">
        <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-sky-700">SilverVisit Telehealth Sandbox</p>
          <h1 className="mt-1 text-4xl font-black text-slate-950">Patient Video Visit Center</h1>
          <p className="mt-2 text-lg text-slate-700">Age-friendly fictional portal with deterministic appointment ambiguity.</p>
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            <div id="flow-progress-label" className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold">Section: {section.replaceAll("_", " ")}</div>
            <div id="portal-state-chip" className="rounded-2xl bg-blue-100 px-3 py-2 text-sm font-semibold text-blue-900">State: {lifecycleLabel(portalState)}</div>
            <div id="fixture-seed-label" className="rounded-2xl bg-violet-100 px-3 py-2 text-sm font-semibold text-violet-900">Seed: {seed}</div>
            <div id="portal-now-text" className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold">Portal time: {formatDateTime(fixture.portalNow)}</div>
          </div>
          <div id="recommended-next-action" className="mt-2 rounded-2xl bg-emerald-100 px-3 py-2 text-base font-semibold text-emerald-900">Next action: {recommendedNext}</div>
        </header>

        {section === "login" ? (
          <section id="step-login-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 id="login-step-title" className="text-3xl font-black text-slate-950">Sign in</h2>
            <p className="mt-2 rounded-xl bg-slate-100 p-3 text-lg">
              Deterministic credentials: {fixture.patientName} · {fixture.patientDob} · {fixture.loginSecret}
            </p>
            <div className="mt-4 grid gap-3">
              <label htmlFor="login-full-name-input" className="font-semibold">Full name</label>
              <input id="login-full-name-input" className="rounded-xl border border-slate-300 px-4 py-3 text-lg" value={fullName} onChange={(event) => setFullName(event.target.value)} />

              <label htmlFor="login-dob-input" className="font-semibold">Date of birth</label>
              <input id="login-dob-input" className="rounded-xl border border-slate-300 px-4 py-3 text-lg" value={dob} onChange={(event) => setDob(event.target.value)} />

              <label htmlFor="login-password-input" className="font-semibold">Password</label>
              <input id="login-password-input" type="password" className="rounded-xl border border-slate-300 px-4 py-3 text-lg" value={password} onChange={(event) => setPassword(event.target.value)} />

              <button
                id="login-continue-btn"
                type="button"
                disabled={!loginMatched}
                onClick={() => {
                  navigate("dashboard", "login_success");
                  setLifecycle("pre_check_in");
                  setEventNote("Signed in successfully.");
                }}
                className="mt-2 rounded-2xl bg-sky-700 px-5 py-3 text-xl font-black text-white disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                Continue to Dashboard
              </button>
              <p id="login-status-text" role="status" className="text-sm text-slate-700">
                {loginMatched ? "Credentials matched." : "Enter seeded credentials to continue."}
              </p>
            </div>
          </section>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <aside className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-lg font-black">Portal Sections</h3>
              <div className="mt-2 grid gap-2 text-left">
                <button id="nav-dashboard-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("dashboard")}>Dashboard</button>
                <button id="nav-upcoming-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("upcoming")}>Upcoming</button>
                <button id="nav-past-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("past")}>Past</button>
                <button id="nav-reports-results-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("reports_results")}>Reports & Results</button>
                <button id="nav-notes-avs-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("notes_avs")}>Notes / AVS</button>
                <button id="nav-messages-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("messages")}>Messages</button>
                <button id="nav-prescriptions-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("prescriptions")}>Prescriptions</button>
                <button id="nav-referrals-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("referrals")}>Referrals</button>
                <button id="nav-help-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("help")}>Need Help Joining?</button>
                <button id="nav-after-visit-btn" className="rounded-xl border border-slate-300 px-3 py-2 font-semibold" onClick={() => navigate("after_visit")}>After Visit</button>
              </div>
              <button
                id="restart-demo-btn"
                type="button"
                onClick={restartWithNextSeed}
                className="mt-3 w-full rounded-2xl bg-slate-900 px-4 py-3 text-lg font-bold text-white"
              >
                Restart With Next Seed
              </button>
            </aside>

            <section className="space-y-4">
              {section === "dashboard" && (
                <article id="dashboard-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Welcome, {fixture.patientName}</h2>
                  <p className="mt-2 text-lg">Use date, time, provider, and status evidence to choose the correct visit.</p>
                  <p className="mt-2 rounded-xl bg-slate-100 p-3 text-base">If you open a wrong appointment, use Help or Return to Appointment to recover.</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button id="dashboard-open-upcoming-btn" type="button" className="rounded-2xl bg-sky-700 px-5 py-3 text-lg font-black text-white" onClick={() => navigate("upcoming")}>Review Appointments</button>
                    <button id="dashboard-open-reports-btn" type="button" className="rounded-2xl border border-slate-300 px-5 py-3 text-lg font-semibold" onClick={() => navigate("reports_results")}>Open Reports</button>
                    <button id="dashboard-open-messages-btn" type="button" className="rounded-2xl border border-slate-300 px-5 py-3 text-lg font-semibold" onClick={() => navigate("messages")}>Open Messages</button>
                  </div>
                </article>
              )}

              {section === "upcoming" && (
                <article id="step-appointments-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Today and Upcoming Appointments</h2>
                  <p className="mt-2 text-lg text-slate-700">Some cards are intentionally similar. Pick by time window and status.</p>
                  <div className="mt-4 grid gap-3">
                    {upcomingAppointments.map((appointment, index) => (
                      <article
                        key={appointment.appointmentId}
                        id={index === 0 ? "appointment-card-main" : `appointment-card-${appointment.appointmentId}`}
                        className="rounded-2xl border border-slate-300 bg-slate-50 p-4"
                      >
                        <p className="text-base font-semibold">{formatDateTime(appointment.scheduledDateTime)}</p>
                        <p className="text-xl font-black">{appointment.providerName} · {appointment.specialty}</p>
                        <p>{appointment.visitType} · {appointment.locationLabel}</p>
                        <p className="mt-1 text-sm">
                          Join window: {formatDateTime(appointment.joinWindowStart)} to {formatDateTime(appointment.joinWindowEnd)}
                        </p>
                        <p className="mt-1 inline-block rounded-full bg-slate-200 px-3 py-1 text-sm font-bold">
                          {statusLabel(appointment.status, appointment.joinableNow)}
                        </p>
                        {appointment.note ? <p className="mt-1 text-sm text-amber-700">{appointment.note}</p> : null}
                        <button
                          id={`open-appointment-details-${appointment.appointmentId}-btn`}
                          type="button"
                          className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setSelectedAppointmentId(appointment.appointmentId);
                            navigate("appointment_details", "appointment_selected", { appointmentId: appointment.appointmentId });
                          }}
                        >
                          Open Appointment Details
                        </button>
                      </article>
                    ))}
                  </div>
                </article>
              )}

              {section === "past" && (
                <article id="past-appointments-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Past Appointments</h2>
                  <div className="mt-4 grid gap-3">
                    {pastAppointments.map((appointment) => (
                      <article key={appointment.appointmentId} id={`past-appointment-card-${appointment.appointmentId}`} className="rounded-2xl border border-slate-300 bg-slate-50 p-4">
                        <p className="font-semibold">{formatDateTime(appointment.scheduledDateTime)}</p>
                        <p className="text-xl font-black">{appointment.providerName}</p>
                        <button
                          id={`open-past-appointment-${appointment.appointmentId}-btn`}
                          type="button"
                          className="mt-2 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setSelectedAppointmentId(appointment.appointmentId);
                            navigate("appointment_details", "past_appointment_opened", { appointmentId: appointment.appointmentId });
                          }}
                        >
                          Open Details
                        </button>
                      </article>
                    ))}
                  </div>
                </article>
              )}

              {section === "reports_results" && (
                <article id="reports-results-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Reports and Test Results</h2>
                  <p className="mt-2 text-lg text-slate-700">Open the exact report by topic, provider, and date.</p>
                  <div className="mt-4 space-y-3">
                    {fixture.reportsResults.map((result, index) => (
                      <section
                        key={result.resultId}
                        id={`report-result-item-${result.resultId}`}
                        className={`rounded-2xl border bg-slate-50 p-4 ${
                          selectedReportId === result.resultId
                            ? "border-sky-500 ring-2 ring-sky-200"
                            : "border-slate-300"
                        } ${index >= 1 ? "min-h-[260px]" : "min-h-[180px]"}`}
                      >
                        <p className="font-semibold">{formatDateTime(result.createdDateTime)}</p>
                        <p className="text-xl font-black">{result.summaryTitle}</p>
                        <p>{result.providerName} · {result.specialty}</p>
                        <p className="text-sm">Topic: {result.topic} · Type: {result.resultType} · Status: {result.status}</p>
                        <button
                          id={`open-report-result-${result.resultId}-btn`}
                          type="button"
                          className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setSelectedReportId(result.resultId);
                            void appendRunEvent("reports_results", "report_opened", { resultId: result.resultId });
                            revealElementById("report-result-detail-card");
                          }}
                        >
                          Open Report Details
                        </button>
                        {selectedReportId === result.resultId ? (
                          <section id="report-result-detail-card" className="mt-4 rounded-2xl border border-slate-300 bg-white p-4">
                            <h3 className="text-2xl font-black">{result.summaryTitle}</h3>
                            <p className="mt-2">{result.summarySnippet}</p>
                            <button
                              id="report-return-appointment-btn"
                              type="button"
                              className="mt-3 rounded-xl border border-slate-300 px-4 py-2"
                              onClick={() => {
                                setSelectedAppointmentId(result.appointmentId);
                                navigate("appointment_details", "report_to_appointment", { appointmentId: result.appointmentId });
                              }}
                            >
                              Return to Related Appointment
                            </button>
                          </section>
                        ) : null}
                      </section>
                    ))}
                  </div>
                </article>
              )}

              {section === "notes_avs" && (
                <article id="notes-avs-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Doctor Notes and After Visit Summaries</h2>
                  <div className="mt-4 space-y-3">
                    {fixture.notesAvs.map((note, index) => (
                      <section
                        key={note.noteId}
                        id={`note-avs-item-${note.noteId}`}
                        className={`rounded-2xl border bg-slate-50 p-4 ${
                          selectedNoteId === note.noteId
                            ? "border-sky-500 ring-2 ring-sky-200"
                            : "border-slate-300"
                        } ${index >= 1 ? "min-h-[240px]" : "min-h-[170px]"}`}
                      >
                        <p className="font-semibold">{formatDateTime(note.completedDateTime)}</p>
                        <p className="text-xl font-black">{note.summaryTitle}</p>
                        <p>{note.providerName} · {note.specialty}</p>
                        <button
                          id={`open-note-avs-${note.noteId}-btn`}
                          type="button"
                          className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setSelectedNoteId(note.noteId);
                            void appendRunEvent("notes_avs", "note_opened", { noteId: note.noteId });
                            revealElementById("note-avs-detail-card");
                          }}
                        >
                          Open Note
                        </button>
                        {selectedNoteId === note.noteId ? (
                          <section id="note-avs-detail-card" className="mt-4 rounded-2xl border border-slate-300 bg-white p-4">
                            <h3 className="text-2xl font-black">{note.summaryTitle}</h3>
                            <p className="mt-2">{note.summarySnippet}</p>
                            <p className="mt-2 text-sm text-slate-600">Topic: {note.topic}</p>
                          </section>
                        ) : null}
                      </section>
                    ))}
                  </div>
                </article>
              )}

              {section === "messages" && (
                <article id="messages-inbox-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Secure Messages</h2>
                  <p className="mt-2 text-lg text-slate-700">Choose the thread that matches provider and topic.</p>
                  <div className="mt-4 space-y-3">
                    {fixture.messageThreads.map((thread) => (
                      <section key={thread.threadId} id={`message-thread-item-${thread.threadId}`} className="rounded-2xl border border-slate-300 bg-slate-50 p-4">
                        <p className="font-semibold">{formatDateTime(thread.updatedDateTime)}</p>
                        <p className="text-xl font-black">{thread.subject}</p>
                        <p>{thread.providerName} · {thread.specialty} · Topic: {thread.topic}</p>
                        <p className="text-sm">{thread.preview}</p>
                        {thread.unreadCount > 0 ? <p className="mt-1 text-sm text-amber-700">Unread: {thread.unreadCount}</p> : null}
                        <button
                          id={`open-message-thread-${thread.threadId}-btn`}
                          type="button"
                          className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setSelectedThreadId(thread.threadId);
                            navigate("message_thread", "thread_opened", { threadId: thread.threadId });
                          }}
                        >
                          Open Thread
                        </button>
                      </section>
                    ))}
                  </div>
                </article>
              )}

              {section === "message_thread" && (
                <article id="message-thread-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Message Thread</h2>
                  {selectedThread ? (
                    <>
                      <p className="mt-2 text-xl font-black">{selectedThread.subject}</p>
                      <p className="text-base">{selectedThread.providerName} · {selectedThread.specialty} · {selectedThread.topic}</p>
                      <div id="message-thread-preview" className="mt-3 rounded-xl bg-slate-100 p-4 text-base">{selectedThread.preview}</div>
                      <button
                        id="send-secure-message-btn"
                        type="button"
                        className="mt-3 rounded-xl bg-sky-700 px-4 py-2 text-white"
                        onClick={() => setEventNote(`Secure message sent to ${selectedThread.providerName}.`)}
                      >
                        Send Secure Message
                      </button>
                    </>
                  ) : (
                    <p className="mt-2">No thread selected.</p>
                  )}
                  <button id="return-to-messages-btn" type="button" className="mt-3 rounded-xl border border-slate-300 px-4 py-2" onClick={() => navigate("messages", "thread_to_messages")}>Back to Messages</button>
                </article>
              )}

              {section === "prescriptions" && (
                <article id="prescriptions-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Prescriptions and Medications</h2>
                  <div className="mt-4 space-y-3">
                    {fixture.prescriptions.map((item, index) => (
                      <section
                        key={item.prescriptionId}
                        id={`prescription-item-${item.prescriptionId}`}
                        className={`rounded-2xl border bg-slate-50 p-4 ${
                          selectedPrescriptionId === item.prescriptionId
                            ? "border-sky-500 ring-2 ring-sky-200"
                            : "border-slate-300"
                        } ${index >= 1 ? "min-h-[220px]" : "min-h-[160px]"}`}
                      >
                        <p className="font-semibold">{formatDateTime(item.createdDateTime)}</p>
                        <p className="text-xl font-black">{item.medicationName} · {item.dosage}</p>
                        <p>{item.providerName} · Topic: {item.topic}</p>
                        <p className="text-sm">Status: {item.status}</p>
                        <button
                          id={`open-prescription-${item.prescriptionId}-btn`}
                          type="button"
                          className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setSelectedPrescriptionId(item.prescriptionId);
                            revealElementById("prescription-detail-card");
                          }}
                        >
                          Open Prescription Details
                        </button>
                        {selectedPrescriptionId === item.prescriptionId ? (
                          <section id="prescription-detail-card" className="mt-4 rounded-2xl border border-slate-300 bg-white p-4">
                            <h3 className="text-2xl font-black">{item.medicationName}</h3>
                            <p className="mt-2">Dosage: {item.dosage}</p>
                            <p className="mt-1 text-sm text-slate-600">Linked appointment: {item.appointmentId}</p>
                          </section>
                        ) : null}
                      </section>
                    ))}
                  </div>
                </article>
              )}

              {section === "referrals" && (
                <article id="referrals-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Referrals</h2>
                  <div className="mt-4 space-y-3">
                    {fixture.referrals.map((item) => (
                      <section
                        key={item.referralId}
                        id={`referral-item-${item.referralId}`}
                        className={`rounded-2xl border bg-slate-50 p-4 ${
                          selectedReferralId === item.referralId
                            ? "border-sky-500 ring-2 ring-sky-200"
                            : "border-slate-300"
                        }`}
                      >
                        <p className="font-semibold">{formatDateTime(item.createdDateTime)}</p>
                        <p className="text-xl font-black">{item.referredTo}</p>
                        <p>{item.providerName} · {item.specialty} · Topic: {item.topic}</p>
                        <p className="text-sm">{item.referralReason}</p>
                        <button
                          id={`open-referral-${item.referralId}-btn`}
                          type="button"
                          className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setSelectedReferralId(item.referralId);
                            revealElementById("referral-detail-card");
                          }}
                        >
                          Open Referral Details
                        </button>
                        {selectedReferralId === item.referralId ? (
                          <section id="referral-detail-card" className="mt-4 rounded-2xl border border-slate-300 bg-white p-4">
                            <h3 className="text-2xl font-black">{item.referredTo}</h3>
                            <p className="mt-2">{item.referralReason}</p>
                            <p className="mt-1 text-sm text-slate-600">Status: {item.status}</p>
                          </section>
                        ) : null}
                      </section>
                    ))}
                  </div>
                </article>
              )}

              {section === "appointment_details" && (
                <article id="step-details-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 id="details-step-title" className="text-3xl font-black">Appointment Details</h2>
                  {selectedAppointment ? (
                    <>
                      <p className="mt-2 text-lg">{formatDateTime(selectedAppointment.scheduledDateTime)} · {selectedAppointment.providerName}</p>
                      <p className="text-base">Status: {statusLabel(selectedAppointment.status, selectedAppointment.joinableNow)}</p>
                      {joinableAppointment && joinableAppointment.appointmentId !== selectedAppointment.appointmentId ? (
                        <div id="wrong-appointment-warning" className="mt-3 rounded-xl bg-amber-100 p-3 text-amber-900">
                          This may be the wrong appointment for right now.
                          <button
                            id="recover-correct-appointment-btn"
                            type="button"
                            className="mt-2 block rounded-xl bg-slate-900 px-4 py-2 text-white"
                            onClick={() => {
                              setSelectedAppointmentId(joinableAppointment.appointmentId);
                              setEventNote("Recovered to currently joinable appointment.");
                              void appendRunEvent("appointment_details", "recover_correct_appointment", {
                                fromAppointment: selectedAppointment.appointmentId,
                                toAppointment: joinableAppointment.appointmentId,
                              });
                            }}
                          >
                            Return to Correct Appointment
                          </button>
                        </div>
                      ) : null}

                      <ul id="details-checklist-list" className="mt-3 list-disc space-y-1 pl-5 text-base">
                        {fixture.detailsChecklist.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>

                      <div className="mt-4 flex flex-wrap gap-2">
                        <button id="details-start-echeckin-btn" type="button" className="rounded-xl bg-sky-700 px-4 py-2 text-white" onClick={() => { setLifecycle("echeckin_in_progress"); navigate("echeckin", "start_echeckin"); }}>
                          Start eCheck-In
                        </button>
                        <button id="details-open-device-setup-btn" type="button" className="rounded-xl border border-slate-300 px-4 py-2" onClick={() => { setLifecycle("device_setup"); navigate("device_setup", "open_device_setup"); }}>
                          Open Device Setup
                        </button>
                        <button id="details-open-help-btn" type="button" className="rounded-xl border border-slate-300 px-4 py-2" onClick={() => navigate("help")}>Need Help Joining?</button>
                        <button id="details-open-results-btn" type="button" className="rounded-xl border border-slate-300 px-4 py-2" onClick={() => navigate("reports_results")}>Open Reports</button>
                        <button id="details-open-messages-btn" type="button" className="rounded-xl border border-slate-300 px-4 py-2" onClick={() => navigate("messages")}>Open Messages</button>
                      </div>

                      <button
                        id="details-enter-waiting-room-btn"
                        type="button"
                        disabled={!canEnterWaiting}
                        className="mt-3 rounded-xl bg-emerald-700 px-4 py-2 text-white disabled:bg-slate-400"
                        onClick={() => {
                          setLifecycle("waiting_room");
                          navigate("waiting_room", "enter_waiting_room", { appointmentId: selectedAppointment.appointmentId });
                        }}
                      >
                        Continue to Waiting Room
                      </button>
                    </>
                  ) : (
                    <p className="mt-2">No appointment selected yet.</p>
                  )}
                </article>
              )}
              {section === "echeckin" && (
                <article id="step-echeckin-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">eCheck-In</h2>
                  <p className="mt-2 text-lg">Required items are intentionally spread down the page.</p>
                  <div className="mt-4 space-y-4">
                    {fixture.preVisitTasks.map((task, index) => (
                      <section
                        key={task.taskId}
                        id={`task-section-${task.section}`}
                        className={`rounded-2xl border border-slate-300 bg-slate-50 p-4 ${index >= 2 ? "min-h-[340px]" : "min-h-[220px]"}`}
                      >
                        <h3 className="text-2xl font-black">{task.label}</h3>
                        <button
                          id={`complete-${task.taskId}-btn`}
                          type="button"
                          disabled={Boolean(taskCompletion[task.taskId])}
                          className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-white disabled:bg-slate-400"
                          onClick={() => {
                            setTaskCompletion((current) => ({ ...current, [task.taskId]: true }));
                            void appendRunEvent("echeckin", "task_completed", { taskId: task.taskId });
                          }}
                        >
                          {taskCompletion[task.taskId] ? "Completed" : "Complete This Task"}
                        </button>
                      </section>
                    ))}
                  </div>
                  <button
                    id="echeckin-finish-btn"
                    type="button"
                    disabled={!tasksDone}
                    className="mt-4 rounded-2xl bg-sky-700 px-5 py-3 text-lg font-bold text-white disabled:bg-slate-400"
                    onClick={() => {
                      setLifecycle("device_setup");
                      navigate("device_setup", "echeckin_completed");
                    }}
                  >
                    Finish eCheck-In
                  </button>
                </article>
              )}

              {section === "device_setup" && (
                <article id="step-device-test-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Device Setup</h2>
                  <p className="mt-2 text-lg">Run all required checks before joining.</p>
                  <div className="mt-4 space-y-4">
                    {fixture.deviceChecks.map((check, index) => (
                      <section
                        key={check.checkId}
                        id={`device-check-${check.checkId}`}
                        className={`rounded-2xl border border-slate-300 bg-slate-50 p-4 ${index >= 1 ? "min-h-[260px]" : "min-h-[200px]"}`}
                      >
                        <h3 className="text-2xl font-black">{check.label}</h3>
                        <button
                          id={`run-${check.checkId}-btn`}
                          type="button"
                          disabled={Boolean(deviceCompletion[check.checkId])}
                          className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-white disabled:bg-slate-400"
                          onClick={() => {
                            setDeviceCompletion((current) => ({ ...current, [check.checkId]: true }));
                            void appendRunEvent("device_setup", "device_check_passed", { checkId: check.checkId });
                          }}
                        >
                          {deviceCompletion[check.checkId] ? "Passed" : "Run Check"}
                        </button>
                      </section>
                    ))}
                  </div>
                  <button
                    id="finish-device-test-btn"
                    type="button"
                    disabled={!devicesDone}
                    className="mt-4 rounded-2xl bg-emerald-700 px-5 py-3 text-lg font-bold text-white disabled:bg-slate-400"
                    onClick={() => {
                      setLifecycle("waiting_room");
                      navigate("waiting_room", "device_checks_complete");
                    }}
                  >
                    Continue to Waiting Room
                  </button>
                </article>
              )}

              {section === "waiting_room" && (
                <article id="step-waiting-room-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 id="waiting-room-step-title" className="text-3xl font-black">Virtual Waiting Room</h2>
                  <p className="mt-2 text-lg">You are not joined yet until Enter Call is completed.</p>
                  <div id="waiting-room-status-text" className="mt-3 rounded-xl bg-amber-100 p-4 text-amber-900">
                    {providerReady ? fixture.clinicianReadyState : fixture.waitingRoomState}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button id="waiting-check-provider-ready-btn" type="button" className="rounded-xl border border-slate-300 px-4 py-2" onClick={() => { setProviderReady(true); setLifecycle("provider_ready"); }}>Refresh Provider Status</button>
                    <button id="waiting-return-details-btn" type="button" className="rounded-xl border border-slate-300 px-4 py-2" onClick={() => navigate("appointment_details", "return_to_details")}>Return to Appointment</button>
                  </div>
                  <button id="enter-call-btn" type="button" disabled={!canJoinCall} className="mt-4 rounded-2xl bg-emerald-700 px-5 py-3 text-lg font-bold text-white disabled:bg-slate-400" onClick={() => { setLifecycle("joined"); navigate("joined", "joined_call"); }}>
                    Enter Call
                  </button>
                </article>
              )}

              {section === "help" && (
                <article id="help-support-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">Need Help Joining?</h2>
                  <div className="mt-4 grid gap-3">
                    {fixture.supportPaths.map((path) => (
                      <section
                        key={path.pathId}
                        id={`support-path-${path.pathId}`}
                        className={`rounded-2xl border bg-slate-50 p-4 ${
                          activeSupportPathId === path.pathId
                            ? "border-sky-500 ring-2 ring-sky-200"
                            : "border-slate-300"
                        }`}
                      >
                        <h3 className="text-xl font-black">{path.label}</h3>
                        <p className="text-base">{path.description}</p>
                        <button
                          id={`open-support-${path.pathId}-btn`}
                          type="button"
                          className="mt-2 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setActiveSupportPathId(path.pathId);
                            revealElementById(`support-path-${path.pathId}`);
                            revealElementById(`support-path-detail-${path.pathId}`);
                          }}
                        >
                          Open Path
                        </button>
                        {activeSupportPathId === path.pathId ? (
                          <section
                            id={`support-path-detail-${path.pathId}`}
                            className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-4"
                          >
                            <p className="font-semibold text-blue-900">Active path: {path.label}</p>
                            <p className="mt-1 text-sm text-blue-900">{path.actionHint}</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button id="support-go-device-setup-btn" type="button" className="rounded-xl border border-slate-300 px-4 py-2" onClick={() => { setActiveSupportPathId(null); setLifecycle("device_setup"); navigate("device_setup", "support_to_device"); }}>Troubleshoot Device</button>
                              <button id="support-call-clinic-now-btn" type="button" className="rounded-xl border border-slate-300 px-4 py-2" onClick={() => setEventNote("Clinic support call simulated.")}>Call Clinic</button>
                              <button id="support-return-to-appointment-btn" type="button" className="rounded-xl bg-slate-900 px-4 py-2 text-white" onClick={() => { setActiveSupportPathId(null); navigate("appointment_details", "support_return_to_appointment"); }}>Return to Appointment</button>
                            </div>
                          </section>
                        ) : null}
                      </section>
                    ))}
                  </div>
                </article>
              )}

              {section === "after_visit" && (
                <article id="after-visit-card" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-3xl font-black">After Visit Summary</h2>
                  <div className="mt-4 grid gap-3">
                    {fixture.pastVisitSummaries.map((summary) => (
                      <section
                        key={summary.visitId}
                        id={`past-visit-summary-${summary.visitId}`}
                        className={`rounded-2xl border bg-slate-50 p-4 ${
                          selectedPastVisitId === summary.visitId
                            ? "border-sky-500 ring-2 ring-sky-200"
                            : "border-slate-300"
                        }`}
                      >
                        <p className="font-semibold">{formatDateTime(summary.completedDateTime)}</p>
                        <p className="text-xl font-black">{summary.summaryTitle}</p>
                        <button
                          id={`open-past-visit-${summary.visitId}-btn`}
                          type="button"
                          className="mt-2 rounded-xl bg-slate-900 px-4 py-2 text-white"
                          onClick={() => {
                            setSelectedPastVisitId(summary.visitId);
                            revealElementById("past-visit-detail-card");
                          }}
                        >
                          Open Summary Details
                        </button>
                        {selectedPastVisitId === summary.visitId ? (
                          <section id="past-visit-detail-card" className="mt-4 rounded-2xl border border-slate-300 bg-white p-4">
                            <h3 className="text-2xl font-black">{summary.summaryTitle}</h3>
                            <p className="mt-2">{summary.summarySnippet}</p>
                          </section>
                        ) : null}
                      </section>
                    ))}
                  </div>
                </article>
              )}

              {section === "joined" && (
                <article id="step-joined-call-card" className="rounded-3xl border border-emerald-300 bg-white p-6 shadow-sm">
                  <h2 id="joined-call-step-title" className="text-3xl font-black text-emerald-900">You have joined the visit</h2>
                  <div id="joined-call-status-text" className="mt-3 rounded-xl bg-emerald-100 p-4 text-emerald-900">{fixture.clinicianReadyState}</div>
                  <button id="joined-open-after-visit-btn" type="button" className="mt-3 rounded-2xl border border-slate-300 px-5 py-3 text-lg font-semibold" onClick={() => navigate("after_visit", "joined_to_after_visit")}>Open After Visit Summary</button>
                </article>
              )}

              <article id="activity-log-card" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-xl font-black text-slate-950">Portal Guidance</h3>
                <p id="flow-tip-text" className="mt-2 text-base text-slate-700">SilverVisit should use grounded evidence and recover from wrong paths.</p>
                <p id="event-note-text" className="mt-2 text-sm text-slate-600">Latest event: {eventNote}</p>
              </article>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}


