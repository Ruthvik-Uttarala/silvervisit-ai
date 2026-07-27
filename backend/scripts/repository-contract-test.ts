import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadConfig } from "../src/config";
import { getRepository } from "../src/repository";

async function main(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    AI_PROVIDER: "gemini_api",
    PERSISTENCE_PROVIDER: "supabase",
    ENABLE_LIVE_API: "false",
  });
  const repository = getRepository(config);
  const diagnostics = repository.getDiagnostics();

  if (!diagnostics.configured) {
    console.log("[contract] Supabase contract tests skipped because SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured.");
    return;
  }

  const seeded = await repository.ensureDeterministicFixtures();
  assert.ok(seeded >= 4, "deterministic fixtures should be seeded");

  const fixture = await repository.getFixtureBySeed(2);
  assert.equal(fixture.seed, 2);
  assert.equal(fixture.fixture.seed, 2);
  assert.equal(typeof fixture.fixture.patientName, "string");
  console.log("[contract] fixture lookup passed");

  const nonexistentWrapped = await repository.getFixtureBySeed(999);
  assert.equal(nonexistentWrapped.seed, 999);
  assert.ok(nonexistentWrapped.fixture.seed >= 1);
  console.log("[contract] nonexistent fixture handling passed");

  const sessionId = crypto.randomUUID();
  await repository.upsertNavigatorSession(sessionId, "Help me join my doctor appointment today.", {
    latestPlanStatus: "ok",
  });
  const session = await repository.getNavigatorSession(sessionId);
  assert.ok(session);
  assert.equal(session.id, sessionId);
  console.log("[contract] session creation and retrieval passed");

  const expiredSessionId = crypto.randomUUID();
  await repository.upsertNavigatorSession(expiredSessionId, "Expired demo session", {
    latestPlanStatus: "ok",
  });
  await fetch(`${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1/navigator_sessions?id=eq.${expiredSessionId}`, {
    method: "PATCH",
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
  });
  const expired = await repository.getNavigatorSession(expiredSessionId);
  assert.equal(expired, null);
  console.log("[contract] expired-session handling passed");

  const run = await repository.startSandboxRun({
    seed: 2,
    source: "extension",
    navigatorSessionId: sessionId,
  });
  assert.equal(run.seed, 2);
  assert.equal(typeof run.runId, "string");
  console.log("[contract] run creation passed");

  await repository.appendSandboxRunEvent({
    runId: run.runId,
    step: "appointments",
    eventType: "step_transition",
    metadata: { source: "contract" },
  });
  console.log("[contract] run-event insertion passed");

  await repository.recordActionLog(sessionId, {
    requestId: crypto.randomUUID(),
    turnId: "contract-turn",
    userGoal: "Help me join my doctor appointment today.",
    pageUrl: "https://silvervisit-ai.vercel.app/?seed=2",
    pageTitle: "SilverVisit",
    action: { type: "click", targetId: "nav-upcoming-btn" },
    status: "ok",
    confidence: 0.8,
    grounding: {
      matchedElementIds: ["nav-upcoming-btn"],
      matchedVisibleText: ["Upcoming"],
      reasoningSummary: "Contract test summary.",
    },
  });
  console.log("[contract] plan-event insertion passed");

  console.log("[contract] All repository contract tests passed.");
}

main().catch((error) => {
  console.error(`[contract] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
