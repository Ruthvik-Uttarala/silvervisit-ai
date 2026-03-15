import crypto from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import {
  AppConfig,
  PlanActionResponse,
  SandboxAppointment,
  SandboxDeviceCheck,
  SandboxFixtureContext,
  SandboxMessageThread,
  SandboxNoteAvs,
  SandboxPastVisitSummary,
  SandboxPrescription,
  SandboxPreVisitTask,
  SandboxReferral,
  SandboxReportResult,
  SandboxRunEventRequest,
  SandboxRunStartRequest,
  SandboxRunStartResponse,
  SandboxSupportPath,
} from "./types";

export type FirestoreMode = "emulator" | "production" | "disabled";

interface RawAppointment {
  appointmentId: string;
  scheduledDateTime: string;
  joinWindowStart: string;
  joinWindowEnd: string;
  status: SandboxAppointment["status"];
  providerName: string;
  specialty: string;
  visitType: string;
  locationLabel: string;
  note?: string;
}

interface RawFixtureData {
  patientName: string;
  patientDob: string;
  loginSecret: string;
  clinicLabel: string;
  waitingRoomState: string;
  clinicianReadyState: string;
  appointmentTimeText: string;
  visitTitle: string;
  detailsChecklist: string[];
  portalNow: string;
  portalState: SandboxFixtureContext["portalState"];
  appointments: RawAppointment[];
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

const COMMON_SUPPORT_PATHS: SandboxSupportPath[] = [
  {
    pathId: "support-need-help-joining",
    label: "Need help joining",
    description: "Step-by-step support for entering today's video visit.",
    actionHint: "Open support helper and return to the correct appointment.",
  },
  {
    pathId: "support-invite-caregiver",
    label: "Invite caregiver",
    description: "Send a caregiver assist link for telehealth check-in.",
    actionHint: "Invite support person and continue with appointment tasks.",
  },
  {
    pathId: "support-call-clinic",
    label: "Call clinic",
    description: "Call front desk for scheduling or access help.",
    actionHint: "Place clinic support call, then return to appointment details.",
  },
  {
    pathId: "support-troubleshoot-device",
    label: "Troubleshoot device",
    description: "Fix camera, mic, and speaker issues before joining.",
    actionHint: "Run device troubleshooting, then return to the join flow.",
  },
  {
    pathId: "support-return-to-appointment",
    label: "Return to appointment",
    description: "Go back to your appointment card and continue.",
    actionHint: "Return to the selected appointment details.",
  },
];

const COMMON_PRE_VISIT_TASKS: SandboxPreVisitTask[] = [
  { taskId: "task-demographics", label: "Confirm demographics", required: true, completed: false, section: "demographics" },
  { taskId: "task-consent", label: "Accept telemedicine consent", required: true, completed: false, section: "consent" },
  { taskId: "task-insurance", label: "Review insurance details", required: true, completed: false, section: "insurance" },
  { taskId: "task-pharmacy", label: "Confirm preferred pharmacy", required: true, completed: false, section: "pharmacy" },
  { taskId: "task-medications", label: "Review medications and allergies", required: true, completed: false, section: "medications" },
  { taskId: "task-language", label: "Confirm language and interpreter needs", required: true, completed: false, section: "language" },
  { taskId: "task-caregiver", label: "Confirm caregiver or support person access", required: true, completed: false, section: "caregiver" },
];

const COMMON_DEVICE_CHECKS: SandboxDeviceCheck[] = [
  { checkId: "device-camera", label: "Camera check", required: true, passed: false },
  { checkId: "device-microphone", label: "Microphone check", required: true, passed: false },
  { checkId: "device-speaker", label: "Speaker check", required: true, passed: false },
];

function inferTopic(appointment: RawAppointment): string {
  const specialty = appointment.specialty.toLowerCase();
  const visitType = appointment.visitType.toLowerCase();
  if (specialty.includes("cardio")) return "cholesterol and heart health";
  if (specialty.includes("pulmo")) return "asthma control";
  if (specialty.includes("geriat")) return "fall prevention";
  if (specialty.includes("care coordination")) return "home support planning";
  if (visitType.includes("medication")) return "medication review";
  return appointment.specialty.toLowerCase();
}

function createDefaultReports(appointments: RawAppointment[]): SandboxReportResult[] {
  return appointments.slice(0, 3).map((appointment, index) => ({
    resultId: `report-${appointment.appointmentId}`,
    appointmentId: appointment.appointmentId,
    createdDateTime: appointment.scheduledDateTime,
    providerName: appointment.providerName,
    specialty: appointment.specialty,
    topic: inferTopic(appointment),
    resultType: index % 2 === 0 ? "Lab Panel" : "Imaging",
    status: appointment.status === "completed" || appointment.status === "past" ? "final" : "pending",
    summaryTitle:
      index % 2 === 0 ? `${appointment.specialty} bloodwork review` : `${appointment.specialty} imaging summary`,
    summarySnippet: `Result linked to ${appointment.visitType} with ${appointment.providerName}.`,
  }));
}

function createDefaultNotes(appointments: RawAppointment[], summaries: SandboxPastVisitSummary[]): SandboxNoteAvs[] {
  const fromSummaries = summaries.map((summary) => ({
    noteId: `note-${summary.visitId}`,
    appointmentId: summary.visitId.replace("summary", "appt"),
    completedDateTime: summary.completedDateTime,
    providerName: summary.providerName,
    specialty: summary.specialty,
    topic: summary.specialty.toLowerCase(),
    summaryTitle: summary.summaryTitle,
    summarySnippet: summary.summarySnippet,
  }));
  const fallback = appointments
    .filter((appointment) => appointment.status === "completed" || appointment.status === "past")
    .slice(0, 2)
    .map((appointment) => ({
      noteId: `note-${appointment.appointmentId}`,
      appointmentId: appointment.appointmentId,
      completedDateTime: appointment.scheduledDateTime,
      providerName: appointment.providerName,
      specialty: appointment.specialty,
      topic: inferTopic(appointment),
      summaryTitle: `${appointment.visitType} after-visit summary`,
      summarySnippet: `Care plan updates from ${appointment.providerName}.`,
    }));
  return [...fromSummaries, ...fallback].slice(0, 4);
}

function createDefaultMessageThreads(appointments: RawAppointment[]): SandboxMessageThread[] {
  return appointments.slice(0, 4).map((appointment, index) => ({
    threadId: `thread-${appointment.appointmentId}`,
    appointmentId: appointment.appointmentId,
    updatedDateTime: appointment.scheduledDateTime,
    providerName: appointment.providerName,
    specialty: appointment.specialty,
    topic: inferTopic(appointment),
    subject: `${appointment.specialty} follow-up`,
    preview:
      index % 2 === 0
        ? "Please review your pre-visit checklist before your appointment."
        : "Your provider sent an update about your care plan.",
    unreadCount: index % 3 === 0 ? 1 : 0,
  }));
}

function createDefaultPrescriptions(appointments: RawAppointment[]): SandboxPrescription[] {
  return appointments.slice(0, 3).map((appointment, index) => ({
    prescriptionId: `rx-${appointment.appointmentId}`,
    appointmentId: appointment.appointmentId,
    createdDateTime: appointment.scheduledDateTime,
    providerName: appointment.providerName,
    specialty: appointment.specialty,
    topic: inferTopic(appointment),
    medicationName: index % 2 === 0 ? "Atorvastatin" : "Lisinopril",
    dosage: index % 2 === 0 ? "20mg nightly" : "10mg each morning",
    status:
      appointment.status === "completed" || appointment.status === "past"
        ? "active"
        : appointment.status === "canceled"
          ? "stopped"
          : "completed",
  }));
}

function createDefaultReferrals(appointments: RawAppointment[]): SandboxReferral[] {
  return appointments.slice(0, 3).map((appointment, index) => ({
    referralId: `ref-${appointment.appointmentId}`,
    appointmentId: appointment.appointmentId,
    createdDateTime: appointment.scheduledDateTime,
    providerName: appointment.providerName,
    specialty: appointment.specialty,
    topic: inferTopic(appointment),
    referredTo: index % 2 === 0 ? "Nutrition Counseling" : "Physical Therapy",
    referralReason:
      index % 2 === 0
        ? "Support diet changes related to visit findings."
        : "Improve mobility and balance after recent symptoms.",
    status:
      appointment.status === "completed" || appointment.status === "past"
        ? "scheduled"
        : appointment.status === "canceled"
          ? "closed"
          : "open",
  }));
}

function createFixture(
  data: Omit<
    RawFixtureData,
    | "preVisitTasks"
    | "deviceChecks"
    | "supportPaths"
    | "pastVisitSummaries"
    | "reportsResults"
    | "notesAvs"
    | "messageThreads"
    | "prescriptions"
    | "referrals"
  > & {
    pastVisitSummaries: SandboxPastVisitSummary[];
    reportsResults?: SandboxReportResult[];
    notesAvs?: SandboxNoteAvs[];
    messageThreads?: SandboxMessageThread[];
    prescriptions?: SandboxPrescription[];
    referrals?: SandboxReferral[];
  },
): RawFixtureData {
  return {
    ...data,
    preVisitTasks: COMMON_PRE_VISIT_TASKS.map((task) => ({ ...task })),
    deviceChecks: COMMON_DEVICE_CHECKS.map((check) => ({ ...check })),
    supportPaths: COMMON_SUPPORT_PATHS.map((path) => ({ ...path })),
    pastVisitSummaries: data.pastVisitSummaries.map((item) => ({ ...item })),
    reportsResults: (data.reportsResults ?? createDefaultReports(data.appointments)).map((item) => ({ ...item })),
    notesAvs: (data.notesAvs ?? createDefaultNotes(data.appointments, data.pastVisitSummaries)).map((item) => ({ ...item })),
    messageThreads: (data.messageThreads ?? createDefaultMessageThreads(data.appointments)).map((item) => ({ ...item })),
    prescriptions: (data.prescriptions ?? createDefaultPrescriptions(data.appointments)).map((item) => ({ ...item })),
    referrals: (data.referrals ?? createDefaultReferrals(data.appointments)).map((item) => ({ ...item })),
  };
}

const DEFAULT_FIXTURES: RawFixtureData[] = [
  createFixture({
    patientName: "Avery Johnson",
    patientDob: "04/11/1952",
    loginSecret: "Avery-Visit-2044",
    clinicLabel: "SilverVisit Video Room",
    waitingRoomState: "You are in the waiting room. Dr. Elena Carter has not joined yet.",
    clinicianReadyState: "Dr. Elena Carter is ready. You may join the visit now.",
    appointmentTimeText: "Today at 2:30 PM",
    visitTitle: "Cardiology Follow-up",
    detailsChecklist: ["Insurance card reviewed", "Consent form pending", "Medication list needs confirmation"],
    portalNow: "2026-03-15T14:18:00-04:00",
    portalState: "pre_check_in",
    appointments: [
      {
        appointmentId: "appt-s1-today-ready",
        scheduledDateTime: "2026-03-15T14:30:00-04:00",
        joinWindowStart: "2026-03-15T14:15:00-04:00",
        joinWindowEnd: "2026-03-15T15:15:00-04:00",
        status: "today",
        providerName: "Dr. Elena Carter",
        specialty: "Cardiology",
        visitType: "Video Follow-up",
        locationLabel: "SilverVisit Video Room",
      },
      {
        appointmentId: "appt-s1-today-later",
        scheduledDateTime: "2026-03-15T16:15:00-04:00",
        joinWindowStart: "2026-03-15T16:00:00-04:00",
        joinWindowEnd: "2026-03-15T16:45:00-04:00",
        status: "today",
        providerName: "Dr. Elena Carter",
        specialty: "Cardiology",
        visitType: "Imaging Review",
        locationLabel: "SilverVisit Video Room",
        note: "Not joinable yet.",
      },
      {
        appointmentId: "appt-s1-past",
        scheduledDateTime: "2026-03-01T14:30:00-05:00",
        joinWindowStart: "2026-03-01T14:15:00-05:00",
        joinWindowEnd: "2026-03-01T15:15:00-05:00",
        status: "completed",
        providerName: "Dr. Elena Carter",
        specialty: "Cardiology",
        visitType: "Video Follow-up",
        locationLabel: "SilverVisit Video Room",
      },
    ],
    pastVisitSummaries: [
      {
        visitId: "summary-s1-1",
        completedDateTime: "2026-03-01T14:30:00-05:00",
        providerName: "Dr. Elena Carter",
        specialty: "Cardiology",
        summaryTitle: "Follow-up blood pressure review",
        summarySnippet: "Continue current medication and monitor blood pressure daily.",
      },
    ],
  }),
  createFixture({
    patientName: "Miguel Thompson",
    patientDob: "12/03/1950",
    loginSecret: "Miguel-Clinic-5501",
    clinicLabel: "SilverVisit Virtual Clinic",
    waitingRoomState: "Waiting room active. Provider is running 5 minutes late.",
    clinicianReadyState: "Dr. Naomi Patel is ready in the room now.",
    appointmentTimeText: "Today at 1:30 PM",
    visitTitle: "Primary Care Check-in",
    detailsChecklist: ["Demographics needs confirmation", "Insurance card photo needed", "Interpreter preference not confirmed"],
    portalNow: "2026-03-15T13:12:00-04:00",
    portalState: "pre_check_in",
    appointments: [
      {
        appointmentId: "appt-s2-today-joinable",
        scheduledDateTime: "2026-03-15T13:30:00-04:00",
        joinWindowStart: "2026-03-15T13:10:00-04:00",
        joinWindowEnd: "2026-03-15T14:20:00-04:00",
        status: "today",
        providerName: "Dr. Naomi Patel",
        specialty: "Primary Care",
        visitType: "Video Check-in",
        locationLabel: "SilverVisit Virtual Clinic",
      },
      {
        appointmentId: "appt-s2-today-not-yet",
        scheduledDateTime: "2026-03-15T15:00:00-04:00",
        joinWindowStart: "2026-03-15T14:45:00-04:00",
        joinWindowEnd: "2026-03-15T15:40:00-04:00",
        status: "today",
        providerName: "Dr. Naima Patel",
        specialty: "Primary Care",
        visitType: "Medication Follow-up",
        locationLabel: "SilverVisit Virtual Clinic",
        note: "Looks similar but not joinable yet.",
      },
      {
        appointmentId: "appt-s2-past-similar",
        scheduledDateTime: "2026-03-08T13:30:00-05:00",
        joinWindowStart: "2026-03-08T13:10:00-05:00",
        joinWindowEnd: "2026-03-08T14:20:00-05:00",
        status: "completed",
        providerName: "Dr. Naomi Patel",
        specialty: "Primary Care",
        visitType: "Video Check-in",
        locationLabel: "SilverVisit Virtual Clinic",
      },
      {
        appointmentId: "appt-s2-past-asthma",
        scheduledDateTime: "2026-03-07T11:15:00-05:00",
        joinWindowStart: "2026-03-07T11:00:00-05:00",
        joinWindowEnd: "2026-03-07T11:45:00-05:00",
        status: "completed",
        providerName: "Dr. Asha Monroe",
        specialty: "Pulmonology",
        visitType: "Asthma Control Follow-up",
        locationLabel: "SilverVisit Virtual Clinic",
      },
      {
        appointmentId: "appt-s2-future",
        scheduledDateTime: "2026-03-17T10:30:00-04:00",
        joinWindowStart: "2026-03-17T10:15:00-04:00",
        joinWindowEnd: "2026-03-17T11:15:00-04:00",
        status: "upcoming",
        providerName: "Dr. Vivian Brooks",
        specialty: "Geriatrics",
        visitType: "Wellness Planning",
        locationLabel: "SilverVisit Virtual Clinic",
      },
    ],
    pastVisitSummaries: [
      {
        visitId: "summary-s2-1",
        completedDateTime: "2026-03-08T13:30:00-05:00",
        providerName: "Dr. Naomi Patel",
        specialty: "Primary Care",
        summaryTitle: "Blood sugar follow-up",
        summarySnippet: "Adjusted meal plan and scheduled medication follow-up.",
      },
      {
        visitId: "summary-s2-2",
        completedDateTime: "2026-02-14T09:00:00-05:00",
        providerName: "Dr. Vivian Brooks",
        specialty: "Geriatrics",
        summaryTitle: "Annual wellness review",
        summarySnippet: "Recommended hearing screening and caregiver planning support.",
      },
      {
        visitId: "summary-s2-3",
        completedDateTime: "2026-03-07T11:15:00-05:00",
        providerName: "Dr. Asha Monroe",
        specialty: "Pulmonology",
        summaryTitle: "Asthma action plan update",
        summarySnippet: "Updated inhaler routine and home trigger checklist.",
      },
    ],
  }),
  createFixture({
    patientName: "Harper Lewis",
    patientDob: "08/28/1956",
    loginSecret: "Harper-Checkin-8820",
    clinicLabel: "SilverVisit Care Portal",
    waitingRoomState: "You are checked in. Provider is reviewing your intake.",
    clinicianReadyState: "Dr. Victor Alvarez is ready and has opened the call.",
    appointmentTimeText: "Today at 4:05 PM",
    visitTitle: "Medication Review",
    detailsChecklist: ["Medication list update required", "Allergy acknowledgment required", "Caregiver contact confirmed"],
    portalNow: "2026-03-15T15:52:00-04:00",
    portalState: "echeckin_in_progress",
    appointments: [
      {
        appointmentId: "appt-s3-today-ready",
        scheduledDateTime: "2026-03-15T16:05:00-04:00",
        joinWindowStart: "2026-03-15T15:50:00-04:00",
        joinWindowEnd: "2026-03-15T16:45:00-04:00",
        status: "today",
        providerName: "Dr. Victor Alvarez",
        specialty: "Geriatric Pharmacology",
        visitType: "Medication Review",
        locationLabel: "SilverVisit Care Portal",
      },
      {
        appointmentId: "appt-s3-past",
        scheduledDateTime: "2026-03-01T16:05:00-05:00",
        joinWindowStart: "2026-03-01T15:50:00-05:00",
        joinWindowEnd: "2026-03-01T16:45:00-05:00",
        status: "past",
        providerName: "Dr. Victor Alvarez",
        specialty: "Geriatric Pharmacology",
        visitType: "Medication Review",
        locationLabel: "SilverVisit Care Portal",
      },
      {
        appointmentId: "appt-s3-rescheduled",
        scheduledDateTime: "2026-03-20T11:00:00-04:00",
        joinWindowStart: "2026-03-20T10:45:00-04:00",
        joinWindowEnd: "2026-03-20T11:40:00-04:00",
        status: "rescheduled",
        providerName: "Dr. Victor Alvarez",
        specialty: "Geriatric Pharmacology",
        visitType: "Medication Review",
        locationLabel: "SilverVisit Care Portal",
      },
    ],
    pastVisitSummaries: [
      {
        visitId: "summary-s3-1",
        completedDateTime: "2026-03-01T16:05:00-05:00",
        providerName: "Dr. Victor Alvarez",
        specialty: "Geriatric Pharmacology",
        summaryTitle: "Medication tolerance check",
        summarySnippet: "Continue dosage and monitor evening dizziness events.",
      },
    ],
  }),
  createFixture({
    patientName: "Riley Garcia",
    patientDob: "01/19/1949",
    loginSecret: "Riley-Ready-4402",
    clinicLabel: "SilverVisit Telehealth Suite",
    waitingRoomState: "Waiting room open. Provider is not ready yet.",
    clinicianReadyState: "Dr. Lena Cho is in room and ready for the call.",
    appointmentTimeText: "Today at 1:45 PM",
    visitTitle: "Care Plan Follow-up",
    detailsChecklist: ["Consent still pending", "Insurance card reviewed", "Interpreter preference pending"],
    portalNow: "2026-03-15T13:33:00-04:00",
    portalState: "pre_check_in",
    appointments: [
      {
        appointmentId: "appt-s4-today-joinable",
        scheduledDateTime: "2026-03-15T13:45:00-04:00",
        joinWindowStart: "2026-03-15T13:30:00-04:00",
        joinWindowEnd: "2026-03-15T14:25:00-04:00",
        status: "today",
        providerName: "Dr. Lena Cho",
        specialty: "Care Coordination",
        visitType: "Care Plan Follow-up",
        locationLabel: "SilverVisit Telehealth Suite",
      },
      {
        appointmentId: "appt-s4-today-not-yet",
        scheduledDateTime: "2026-03-15T15:10:00-04:00",
        joinWindowStart: "2026-03-15T14:55:00-04:00",
        joinWindowEnd: "2026-03-15T15:45:00-04:00",
        status: "today",
        providerName: "Dr. Lina Cho",
        specialty: "Care Coordination",
        visitType: "Care Plan Follow-up",
        locationLabel: "SilverVisit Telehealth Suite",
        note: "Similar provider name but starts later.",
      },
      {
        appointmentId: "appt-s4-past-similar",
        scheduledDateTime: "2026-03-08T13:45:00-05:00",
        joinWindowStart: "2026-03-08T13:30:00-05:00",
        joinWindowEnd: "2026-03-08T14:25:00-05:00",
        status: "completed",
        providerName: "Dr. Lena Cho",
        specialty: "Care Coordination",
        visitType: "Care Plan Follow-up",
        locationLabel: "SilverVisit Telehealth Suite",
      },
      {
        appointmentId: "appt-s4-canceled",
        scheduledDateTime: "2026-03-16T10:00:00-04:00",
        joinWindowStart: "2026-03-16T09:45:00-04:00",
        joinWindowEnd: "2026-03-16T10:30:00-04:00",
        status: "canceled",
        providerName: "Dr. Lena Cho",
        specialty: "Care Coordination",
        visitType: "Care Plan Follow-up",
        locationLabel: "SilverVisit Telehealth Suite",
      },
    ],
    pastVisitSummaries: [
      {
        visitId: "summary-s4-1",
        completedDateTime: "2026-03-08T13:45:00-05:00",
        providerName: "Dr. Lena Cho",
        specialty: "Care Coordination",
        summaryTitle: "Caregiver coordination follow-up",
        summarySnippet: "Updated transportation and home support plan.",
      },
    ],
  }),
  createFixture({
    patientName: "Jordan Kim",
    patientDob: "07/02/1954",
    loginSecret: "Jordan-Portal-7314",
    clinicLabel: "SilverVisit Remote Visit",
    waitingRoomState: "You are in queue. The care team will connect soon.",
    clinicianReadyState: "Dr. Priya Raman is available to join now.",
    appointmentTimeText: "Today at 11:20 AM",
    visitTitle: "Wellness Check",
    detailsChecklist: ["Questionnaire complete", "Medication list complete", "Support contact complete"],
    portalNow: "2026-03-15T11:08:00-04:00",
    portalState: "device_setup",
    appointments: [
      {
        appointmentId: "appt-s5-today-ready",
        scheduledDateTime: "2026-03-15T11:20:00-04:00",
        joinWindowStart: "2026-03-15T11:05:00-04:00",
        joinWindowEnd: "2026-03-15T12:00:00-04:00",
        status: "today",
        providerName: "Dr. Priya Raman",
        specialty: "Preventive Medicine",
        visitType: "Wellness Check",
        locationLabel: "SilverVisit Remote Visit",
      },
      {
        appointmentId: "appt-s5-upcoming",
        scheduledDateTime: "2026-03-19T09:40:00-04:00",
        joinWindowStart: "2026-03-19T09:25:00-04:00",
        joinWindowEnd: "2026-03-19T10:20:00-04:00",
        status: "upcoming",
        providerName: "Dr. Priya Raman",
        specialty: "Preventive Medicine",
        visitType: "Lab Review",
        locationLabel: "SilverVisit Remote Visit",
      },
    ],
    pastVisitSummaries: [
      {
        visitId: "summary-s5-1",
        completedDateTime: "2026-02-20T11:20:00-05:00",
        providerName: "Dr. Priya Raman",
        specialty: "Preventive Medicine",
        summaryTitle: "Routine wellness review",
        summarySnippet: "Recommended exercise updates and next lab review in 4 weeks.",
      },
    ],
  }),
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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toEpoch(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function computeJoinableNow(
  portalNow: string,
  appointment: Pick<SandboxAppointment, "joinWindowStart" | "joinWindowEnd" | "status">,
): boolean {
  if (
    appointment.status === "completed" ||
    appointment.status === "past" ||
    appointment.status === "canceled" ||
    appointment.status === "rescheduled"
  ) {
    return false;
  }
  const now = toEpoch(portalNow);
  const windowStart = toEpoch(appointment.joinWindowStart);
  const windowEnd = toEpoch(appointment.joinWindowEnd);
  if (!Number.isFinite(now) || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    return false;
  }
  return now >= windowStart && now <= windowEnd;
}

function normalizeFixture(raw: RawFixtureData): Omit<SandboxFixtureContext, "seed" | "fixtureId"> {
  const appointments: SandboxAppointment[] = raw.appointments.map((appointment) => {
    const joinableNow = computeJoinableNow(raw.portalNow, appointment);
    const status: SandboxAppointment["status"] =
      joinableNow && (appointment.status === "today" || appointment.status === "upcoming")
        ? "ready_to_join"
        : appointment.status;
    return {
      appointmentId: appointment.appointmentId,
      scheduledDateTime: appointment.scheduledDateTime,
      joinWindowStart: appointment.joinWindowStart,
      joinWindowEnd: appointment.joinWindowEnd,
      status,
      joinableNow,
      providerName: appointment.providerName,
      specialty: appointment.specialty,
      visitType: appointment.visitType,
      locationLabel: appointment.locationLabel,
      note: appointment.note,
    };
  });

  const primaryAppointment =
    appointments.find((item) => item.joinableNow) ??
    appointments.find((item) => item.status === "today" || item.status === "ready_to_join" || item.status === "upcoming") ??
    appointments[0];

  return {
    patientName: raw.patientName,
    patientDob: raw.patientDob,
    loginSecret: raw.loginSecret,
    doctorName: primaryAppointment?.providerName ?? "Care Team",
    appointmentType: primaryAppointment?.visitType ?? raw.visitTitle,
    clinicLabel: raw.clinicLabel,
    waitingRoomState: raw.waitingRoomState,
    clinicianReadyState: raw.clinicianReadyState,
    appointmentTimeText: raw.appointmentTimeText,
    visitTitle: primaryAppointment?.visitType ?? raw.visitTitle,
    detailsChecklist: [...raw.detailsChecklist],
    portalNow: raw.portalNow,
    portalState: raw.portalState,
    appointments,
    preVisitTasks: raw.preVisitTasks.map((task) => ({ ...task })),
    deviceChecks: raw.deviceChecks.map((check) => ({ ...check })),
    supportPaths: raw.supportPaths.map((path) => ({ ...path })),
    pastVisitSummaries: raw.pastVisitSummaries.map((summary) => ({ ...summary })),
    reportsResults: raw.reportsResults.map((item) => ({ ...item })),
    notesAvs: raw.notesAvs.map((item) => ({ ...item })),
    messageThreads: raw.messageThreads.map((item) => ({ ...item })),
    prescriptions: raw.prescriptions.map((item) => ({ ...item })),
    referrals: raw.referrals.map((item) => ({ ...item })),
  };
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
  if (typeof doc.fixtureId !== "string" || typeof doc.seed !== "number") {
    return null;
  }
  const patientName = asString(doc.patientName);
  const patientDob = asString(doc.patientDob);
  const loginSecret = asString(doc.loginSecret);
  const doctorName = asString(doc.doctorName);
  const appointmentType = asString(doc.appointmentType);
  const clinicLabel = asString(doc.clinicLabel);
  const waitingRoomState = asString(doc.waitingRoomState);
  const clinicianReadyState = asString(doc.clinicianReadyState);
  const appointmentTimeText = asString(doc.appointmentTimeText);
  const visitTitle = asString(doc.visitTitle);
  if (
    !patientName ||
    !patientDob ||
    !loginSecret ||
    !doctorName ||
    !appointmentType ||
    !clinicLabel ||
    !waitingRoomState ||
    !clinicianReadyState ||
    !appointmentTimeText ||
    !visitTitle
  ) {
    return null;
  }
  const portalStateValue = asString(doc.portalState);
  const allowedPortalStates = new Set([
    "pre_check_in",
    "echeckin_in_progress",
    "device_setup",
    "waiting_room",
    "provider_ready",
    "joined",
  ]);
  const portalNow = asString(doc.portalNow);
  const statusAllowed = new Set([
    "upcoming",
    "today",
    "ready_to_join",
    "waiting_room",
    "completed",
    "past",
    "canceled",
    "rescheduled",
  ]);

  const appointments = Array.isArray(doc.appointments)
    ? doc.appointments
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => {
          const statusRaw = asString(item.status) as SandboxAppointment["status"];
          if (!statusAllowed.has(statusRaw)) {
            return null;
          }
          const appointment: SandboxAppointment = {
            appointmentId: asString(item.appointmentId),
            scheduledDateTime: asString(item.scheduledDateTime),
            joinWindowStart: asString(item.joinWindowStart),
            joinWindowEnd: asString(item.joinWindowEnd),
            status: statusRaw,
            joinableNow: Boolean(item.joinableNow),
            providerName: asString(item.providerName),
            specialty: asString(item.specialty),
            visitType: asString(item.visitType),
            locationLabel: asString(item.locationLabel),
            note: asString(item.note),
          };
          if (
            !appointment.appointmentId ||
            !appointment.scheduledDateTime ||
            !appointment.joinWindowStart ||
            !appointment.joinWindowEnd ||
            !appointment.providerName ||
            !appointment.specialty ||
            !appointment.visitType ||
            !appointment.locationLabel
          ) {
            return null;
          }
          appointment.joinableNow = computeJoinableNow(portalNow, appointment);
          return appointment;
        })
        .filter((item): item is SandboxAppointment => Boolean(item))
    : [];

  return {
    fixtureId: doc.fixtureId,
    seed: doc.seed,
    patientName,
    patientDob,
    loginSecret,
    doctorName,
    appointmentType,
    clinicLabel,
    waitingRoomState,
    clinicianReadyState,
    appointmentTimeText,
    visitTitle,
    detailsChecklist: Array.isArray(doc.detailsChecklist)
      ? doc.detailsChecklist.filter((item): item is string => typeof item === "string")
      : [],
    portalNow,
    portalState: allowedPortalStates.has(portalStateValue)
      ? (portalStateValue as SandboxFixtureContext["portalState"])
      : "pre_check_in",
    appointments,
    preVisitTasks: Array.isArray(doc.preVisitTasks)
      ? doc.preVisitTasks
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            taskId: asString(item.taskId),
            label: asString(item.label),
            required: Boolean(item.required),
            completed: Boolean(item.completed),
            section: asString(item.section),
          }))
          .filter((item) => item.taskId && item.label && item.section)
      : [],
    deviceChecks: Array.isArray(doc.deviceChecks)
      ? doc.deviceChecks
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            checkId: asString(item.checkId),
            label: asString(item.label),
            required: Boolean(item.required),
            passed: Boolean(item.passed),
          }))
          .filter((item) => item.checkId && item.label)
      : [],
    supportPaths: Array.isArray(doc.supportPaths)
      ? doc.supportPaths
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            pathId: asString(item.pathId),
            label: asString(item.label),
            description: asString(item.description),
            actionHint: asString(item.actionHint),
          }))
          .filter((item) => item.pathId && item.label && item.description && item.actionHint)
      : [],
    pastVisitSummaries: Array.isArray(doc.pastVisitSummaries)
      ? doc.pastVisitSummaries
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            visitId: asString(item.visitId),
            completedDateTime: asString(item.completedDateTime),
            providerName: asString(item.providerName),
            specialty: asString(item.specialty),
            summaryTitle: asString(item.summaryTitle),
            summarySnippet: asString(item.summarySnippet),
          }))
          .filter((item) => item.visitId && item.completedDateTime && item.providerName && item.specialty && item.summaryTitle)
      : [],
    reportsResults: Array.isArray(doc.reportsResults)
      ? doc.reportsResults
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => {
            const status: SandboxReportResult["status"] = asString(item.status) === "pending" ? "pending" : "final";
            return {
              resultId: asString(item.resultId),
              appointmentId: asString(item.appointmentId),
              createdDateTime: asString(item.createdDateTime),
              providerName: asString(item.providerName),
              specialty: asString(item.specialty),
              topic: asString(item.topic),
              resultType: asString(item.resultType),
              status,
              summaryTitle: asString(item.summaryTitle),
              summarySnippet: asString(item.summarySnippet),
            };
          })
          .filter(
            (item) =>
              item.resultId &&
              item.appointmentId &&
              item.createdDateTime &&
              item.providerName &&
              item.specialty &&
              item.topic &&
              item.resultType &&
              item.summaryTitle,
          )
      : [],
    notesAvs: Array.isArray(doc.notesAvs)
      ? doc.notesAvs
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            noteId: asString(item.noteId),
            appointmentId: asString(item.appointmentId),
            completedDateTime: asString(item.completedDateTime),
            providerName: asString(item.providerName),
            specialty: asString(item.specialty),
            topic: asString(item.topic),
            summaryTitle: asString(item.summaryTitle),
            summarySnippet: asString(item.summarySnippet),
          }))
          .filter(
            (item) =>
              item.noteId &&
              item.appointmentId &&
              item.completedDateTime &&
              item.providerName &&
              item.specialty &&
              item.topic &&
              item.summaryTitle,
          )
      : [],
    messageThreads: Array.isArray(doc.messageThreads)
      ? doc.messageThreads
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            threadId: asString(item.threadId),
            appointmentId: asString(item.appointmentId) || undefined,
            updatedDateTime: asString(item.updatedDateTime),
            providerName: asString(item.providerName),
            specialty: asString(item.specialty),
            topic: asString(item.topic),
            subject: asString(item.subject),
            preview: asString(item.preview),
            unreadCount: Math.max(0, Math.floor(Number(item.unreadCount) || 0)),
          }))
          .filter(
            (item) =>
              item.threadId &&
              item.updatedDateTime &&
              item.providerName &&
              item.specialty &&
              item.topic &&
              item.subject &&
              item.preview,
          )
      : [],
    prescriptions: Array.isArray(doc.prescriptions)
      ? doc.prescriptions
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => {
            const status = asString(item.status);
            const normalizedStatus: SandboxPrescription["status"] =
              status === "completed" || status === "stopped" ? status : "active";
            return {
              prescriptionId: asString(item.prescriptionId),
              appointmentId: asString(item.appointmentId),
              createdDateTime: asString(item.createdDateTime),
              providerName: asString(item.providerName),
              specialty: asString(item.specialty),
              topic: asString(item.topic),
              medicationName: asString(item.medicationName),
              dosage: asString(item.dosage),
              status: normalizedStatus,
            };
          })
          .filter(
            (item) =>
              item.prescriptionId &&
              item.appointmentId &&
              item.createdDateTime &&
              item.providerName &&
              item.specialty &&
              item.topic &&
              item.medicationName &&
              item.dosage,
          )
      : [],
    referrals: Array.isArray(doc.referrals)
      ? doc.referrals
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => {
            const status = asString(item.status);
            const normalizedStatus: SandboxReferral["status"] =
              status === "scheduled" || status === "closed" ? status : "open";
            return {
              referralId: asString(item.referralId),
              appointmentId: asString(item.appointmentId),
              createdDateTime: asString(item.createdDateTime),
              providerName: asString(item.providerName),
              specialty: asString(item.specialty),
              topic: asString(item.topic),
              referredTo: asString(item.referredTo),
              referralReason: asString(item.referralReason),
              status: normalizedStatus,
            };
          })
          .filter(
            (item) =>
              item.referralId &&
              item.appointmentId &&
              item.createdDateTime &&
              item.providerName &&
              item.specialty &&
              item.topic &&
              item.referredTo &&
              item.referralReason,
          )
      : [],
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
      const normalized = normalizeFixture(DEFAULT_FIXTURES[i]);
      const ref = collection.doc(fixtureId);
      batch.set(
        ref,
        {
          fixtureId,
          seed,
          ...normalized,
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
