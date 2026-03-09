import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { planAction, startSession } from "../lib/api";
import type { BackgroundResponse, PageSnapshot, PlanActionResponse } from "../lib/types";

const DEFAULT_USER_GOAL = "Help me join my telehealth visit";
const SEEDED_TRANSCRIPT = "Agent: I see your appointment. Look for the blue ring on your screen.";

async function sendBackgroundMessage<T extends BackgroundResponse>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as T;
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response;
}

function summarizeSnapshot(snapshot: PageSnapshot) {
  return `${snapshot.elements.length} elements and ${snapshot.visibleText.length} visible text snippets`;
}

function confidenceLabel(confidence: number) {
  return `${Math.round(confidence * 100)}%`;
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string[]>([SEEDED_TRANSCRIPT]);
  const [latestPlan, setLatestPlan] = useState<PlanActionResponse | null>(null);

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const activeTabResponse = await sendBackgroundMessage<{ ok: true; tab: { tabId: number; title?: string; url?: string } }>({
        type: "GET_ACTIVE_TAB",
      });

      const activeSessionId =
        sessionId ??
        (
          await startSession({
            userGoal: DEFAULT_USER_GOAL,
          })
        ).sessionId;

      const snapshotResponse = await sendBackgroundMessage<{ ok: true; snapshot: PageSnapshot }>({
        type: "COLLECT_PAGE_STATE",
      });

      const plan = await planAction({
        sessionId: activeSessionId,
        userGoal: DEFAULT_USER_GOAL,
        pageUrl: snapshotResponse.snapshot.pageUrl || activeTabResponse.tab.url,
        pageTitle: snapshotResponse.snapshot.pageTitle || activeTabResponse.tab.title,
        visibleText: snapshotResponse.snapshot.visibleText,
        elements: snapshotResponse.snapshot.elements,
      });

      if (plan.status === "ok" && plan.action.type === "highlight" && plan.action.targetId) {
        await sendBackgroundMessage<{ ok: true; message: string }>({
          type: "HIGHLIGHT",
          id: plan.action.targetId,
        });
      } else if (plan.status === "ok" && plan.action.type !== "ask_user" && plan.action.type !== "done") {
        await sendBackgroundMessage<{ ok: true; message: string }>({
          type: "EXECUTE_ACTION",
          action: plan.action,
        });
      }

      return {
        sessionId: activeSessionId,
        snapshot: snapshotResponse.snapshot,
        plan,
      };
    },
    onSuccess: ({ sessionId: nextSessionId, snapshot, plan }) => {
      setSessionId(nextSessionId);
      setLatestPlan(plan);
      setTranscript((current) => [
        ...current,
        `Agent: I analyzed ${summarizeSnapshot(snapshot)} on the current page.`,
        `Agent: ${plan.message}`,
        `Agent: ${plan.grounding.reasoningSummary}`,
      ]);
    },
    onError: (error) => {
      setTranscript((current) => [
        ...current,
        `Agent: ${(error as Error).message}`,
      ]);
    },
  });

  const statusLine = useMemo(() => {
    if (analyzeMutation.isPending) {
      return "Status: Analyzing screen...";
    }

    if (latestPlan?.status === "ok" && latestPlan.action.type === "highlight") {
      return "Status: Join button highlighted";
    }

    if (latestPlan?.status === "need_clarification") {
      return "Status: Need clarification";
    }

    if (latestPlan?.status === "error") {
      return "Status: Planner error";
    }

    return "Status: Waiting for Agent...";
  }, [analyzeMutation.isPending, latestPlan]);

  return (
    <main className="min-h-screen bg-white text-slate-950">
      <div className="flex min-h-screen flex-col gap-6 px-6 py-8">
        <header className="space-y-4 rounded-[2rem] border-2 border-slate-900 bg-slate-50 p-6">
          <p className="text-sm font-bold uppercase tracking-[0.22em] text-sky-700">SilverVisit Helper</p>
          <h1 className="text-3xl font-black tracking-tight text-slate-950">Help Me Join</h1>
          <p className="text-2xl font-semibold leading-10 text-slate-900">
            Analyze the current dashboard and guide the patient to the correct appointment control.
          </p>
        </header>

        <section className="rounded-[2rem] border-2 border-slate-900 bg-white p-6 shadow-sm">
          <p className="text-2xl font-semibold leading-10 text-slate-900">{statusLine}</p>
          <p className="mt-3 text-lg leading-8 text-slate-700">
            The helper starts a session, captures the visible dashboard state, asks the backend for the next safe UI
            action, and then highlights or executes that action on the active tab.
          </p>
        </section>

        <button
          type="button"
          onClick={() => analyzeMutation.mutate()}
          disabled={analyzeMutation.isPending}
          className="rounded-[2rem] border-2 border-slate-900 bg-slate-950 px-6 py-5 text-2xl font-black text-white transition hover:bg-sky-700 disabled:cursor-progress disabled:bg-slate-700"
        >
          {analyzeMutation.isPending ? "Analyzing Screen..." : "Help Me Join"}
        </button>

        <section className="rounded-[2rem] border-2 border-slate-900 bg-slate-50 p-6">
          <h2 className="text-2xl font-black text-slate-950">Transcript</h2>
          <div className="mt-4 space-y-3 rounded-[1.5rem] bg-white p-4 shadow-inner ring-1 ring-slate-200">
            {transcript.map((line, index) => (
              <p key={`${line}-${index}`} className="text-2xl leading-10 text-slate-900">
                {line}
              </p>
            ))}
          </div>
        </section>

        <section className="rounded-[2rem] border-2 border-slate-900 bg-white p-6">
          <h2 className="text-xl font-black text-slate-950">Planner Details</h2>
          <div className="mt-4 space-y-3 text-lg leading-8 text-slate-700">
            <p>Session: {sessionId ?? "Not started"}</p>
            <p>Goal: {DEFAULT_USER_GOAL}</p>
            <p>Action: {latestPlan?.action.type ?? "Waiting for planner"}</p>
            <p>Confidence: {latestPlan ? confidenceLabel(latestPlan.confidence) : "N/A"}</p>
          </div>
        </section>
      </div>
    </main>
  );
}
