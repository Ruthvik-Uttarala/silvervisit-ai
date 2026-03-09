import { useMemo, useState } from "react";

type FlowStep =
  | "login"
  | "appointments"
  | "details"
  | "camera"
  | "microphone"
  | "device-test"
  | "waiting-room"
  | "joined-call";

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

function stepLabel(step: FlowStep) {
  switch (step) {
    case "login":
      return "Login";
    case "appointments":
      return "Appointments";
    case "details":
      return "Visit Details";
    case "camera":
      return "Camera";
    case "microphone":
      return "Microphone";
    case "device-test":
      return "Device Test";
    case "waiting-room":
      return "Waiting Room";
    case "joined-call":
      return "Joined Call";
  }
}

export default function App() {
  const [step, setStep] = useState<FlowStep>("login");
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [password, setPassword] = useState("");
  const [deviceNote, setDeviceNote] = useState("");

  const progress = useMemo(() => {
    const currentIndex = STEP_ORDER.indexOf(step);
    return `${currentIndex + 1} / ${STEP_ORDER.length}`;
  }, [step]);

  const canLogin = fullName.trim().length > 1 && dob.trim().length > 0 && password.trim().length > 2;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-5 py-8 lg:px-10">
        <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-sky-700">SilverVisit Telehealth Sandbox</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">Telehealth Check-In Demo Flow</h1>
          <p className="mt-2 text-lg text-slate-700">
            Deterministic path for UI Navigator demos: login to joined call, with stable actionable IDs on each step.
          </p>
          <div className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-base text-slate-800" id="flow-progress-label">
            Progress: {progress} ({stepLabel(step)})
          </div>
        </header>

        {step === "login" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" id="step-login-card">
            <h2 className="text-2xl font-bold text-slate-950" id="login-step-title">
              Sign in to your patient portal
            </h2>
            <p className="mt-2 text-base text-slate-700">Enter your information to continue to your appointment dashboard.</p>

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
                onClick={() => setStep("appointments")}
                disabled={!canLogin}
                className="mt-2 rounded-2xl bg-sky-700 px-5 py-3 text-lg font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                Continue to Appointments
              </button>

              <div id="login-status-text" role="status" aria-live="polite" className="text-sm text-slate-600">
                {canLogin
                  ? "You can continue to appointments."
                  : "Fill name, date of birth, and password to continue."}
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
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Today at 2:30 PM</p>
              <h3 className="mt-1 text-xl font-bold text-slate-950">Dr. Elena Carter - Follow-up Visit</h3>
              <p className="mt-1 text-base text-slate-700">SilverVisit Video Room</p>
              <button
                id="open-appointment-details-btn"
                type="button"
                onClick={() => setStep("details")}
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
            <p className="mt-2 text-base text-slate-700">
              Complete check-in and join the visit when ready.
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-base text-slate-700" id="details-checklist-list">
              <li>Insurance on file</li>
              <li>Consent received</li>
              <li>Estimated wait time: 3 minutes</li>
            </ul>
            <button
              id="join-visit-btn"
              type="button"
              onClick={() => setStep("camera")}
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
              Allow camera to continue. This is a simulated permission step for the demo.
            </p>
            <button
              id="camera-allow-btn"
              type="button"
              onClick={() => setStep("microphone")}
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
              Allow microphone to continue. This is a simulated permission step for the demo.
            </p>
            <button
              id="microphone-allow-btn"
              type="button"
              onClick={() => setStep("device-test")}
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
            <p className="mt-2 text-base text-slate-700">
              Type any quick note and continue to the waiting room.
            </p>
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
              onClick={() => setStep("waiting-room")}
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
              Status: Waiting for Dr. Elena Carter...
            </div>
            <button
              id="enter-call-btn"
              type="button"
              onClick={() => setStep("joined-call")}
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
              Status: Connected with Dr. Elena Carter.
            </div>
            <button
              id="restart-demo-btn"
              type="button"
              onClick={() => {
                setStep("login");
                setFullName("");
                setDob("");
                setPassword("");
                setDeviceNote("");
              }}
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
