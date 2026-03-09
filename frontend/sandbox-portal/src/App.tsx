import { useMemo, useState } from "react";

type Appointment = {
  id: string;
  clinician: string;
  time: string;
  location: string;
  note: string;
};

const appointment: Appointment = {
  id: "visit-001",
  clinician: "Dr. Elena Carter",
  time: "Today at 2:30 PM",
  location: "SilverVisit Video Room",
  note: "Please have your medication list nearby before the call begins.",
};

export default function App() {
  const [status, setStatus] = useState("Waiting for Agent...");

  const appointmentSummary = useMemo(
    () => `${appointment.time} with ${appointment.clinician} in ${appointment.location}`,
    [],
  );

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-10 px-6 py-12 lg:px-10">
        <header className="flex flex-col gap-4 rounded-[2rem] bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">SilverVisit Sandbox</p>
          <h1 className="text-4xl font-semibold tracking-tight text-slate-950">Upcoming Appointments</h1>
          <p className="max-w-3xl text-lg leading-8 text-slate-600">
            This sandbox simulates the patient dashboard the Chrome extension will inspect. The primary call-to-action
            remains stable so the agent can reliably ground the next action.
          </p>
        </header>

        <section
          aria-label="Appointment summary"
          className="grid gap-6 rounded-[2rem] bg-white p-8 shadow-sm ring-1 ring-slate-200 lg:grid-cols-[1.3fr_0.7fr]"
        >
          <div className="space-y-6">
            <div className="space-y-2">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Next visit</p>
              <h2 className="text-3xl font-semibold text-slate-950">{appointment.clinician}</h2>
              <p className="text-lg text-slate-600">{appointmentSummary}</p>
            </div>

            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-3xl bg-slate-100 p-5">
                <dt className="text-sm font-medium uppercase tracking-wide text-slate-500">Time</dt>
                <dd className="mt-2 text-xl font-semibold text-slate-900">{appointment.time}</dd>
              </div>
              <div className="rounded-3xl bg-slate-100 p-5">
                <dt className="text-sm font-medium uppercase tracking-wide text-slate-500">Location</dt>
                <dd className="mt-2 text-xl font-semibold text-slate-900">{appointment.location}</dd>
              </div>
            </dl>

            <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Care team note</p>
              <p className="mt-3 text-base leading-7 text-slate-700">{appointment.note}</p>
            </div>
          </div>

          <aside className="flex flex-col justify-between gap-6 rounded-[1.75rem] bg-slate-950 p-6 text-white shadow-lg">
            <div className="space-y-3">
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-300">Appointment actions</p>
              <p className="text-lg leading-8 text-slate-200">
                The extension should find the main join control and highlight it for the patient.
              </p>
            </div>

            <button
              id="join-visit-btn"
              type="button"
              onClick={() => setStatus("Joining Room...")}
              className="rounded-3xl bg-sky-500 px-6 py-5 text-2xl font-semibold text-white shadow-lg transition hover:bg-sky-400 focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-sky-200"
            >
              Join Video Visit
            </button>

            <div
              role="status"
              aria-live="polite"
              className="rounded-3xl border border-white/15 bg-white/10 px-5 py-4 text-lg font-medium text-slate-100"
            >
              Status: {status}
            </div>
          </aside>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {[
            "Complete pre-visit forms",
            "Test camera and microphone",
            "Keep this page open for the agent",
          ].map((item) => (
            <div key={item} className="rounded-3xl bg-white p-6 text-lg text-slate-700 shadow-sm ring-1 ring-slate-200">
              {item}
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
