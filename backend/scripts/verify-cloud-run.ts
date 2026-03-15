import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { WebSocket } from "ws";

type CheckStatus = "pass" | "fail" | "warn";

interface VerificationCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface Args {
  baseUrl: string;
  service: string;
  region: string;
  project: string;
  accessTokenFile?: string;
}

const ALLOWED_PLAN_STATUSES = new Set(["ok", "need_clarification", "error"]);
const LIVE_WARNING_CODES = new Set(["live_disabled", "live_not_configured", "live_start_failed", "live_runtime_error"]);

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--base-url" && next) {
      out.baseUrl = next.trim();
      i += 1;
      continue;
    }
    if (token === "--service" && next) {
      out.service = next.trim();
      i += 1;
      continue;
    }
    if (token === "--region" && next) {
      out.region = next.trim();
      i += 1;
      continue;
    }
    if (token === "--project" && next) {
      out.project = next.trim();
      i += 1;
      continue;
    }
    if (token === "--access-token-file" && next) {
      out.accessTokenFile = next.trim();
      i += 1;
      continue;
    }
  }

  if (!out.baseUrl || !out.service || !out.region || !out.project) {
    throw new Error(
      "Usage: tsx scripts/verify-cloud-run.ts --base-url <url> --service <name> --region <region> --project <project> [--access-token-file <path>]",
    );
  }

  return out as Args;
}

function withNoTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function toWsUrl(baseUrl: string): string {
  if (baseUrl.startsWith("https://")) return `wss://${baseUrl.slice("https://".length)}`;
  if (baseUrl.startsWith("http://")) return `ws://${baseUrl.slice("http://".length)}`;
  throw new Error(`Unsupported base URL protocol: ${baseUrl}`);
}

function parseJsonFile(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runGcloud(args: string[], accessTokenFile?: string): { status: number; stdout: string; stderr: string } {
  const cmd = process.platform === "win32" ? "gcloud.cmd" : "gcloud";
  const fullArgs = [...(accessTokenFile ? [`--access-token-file=${accessTokenFile}`] : []), ...args];
  const result = spawnSync(cmd, fullArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function extractTimeoutSeconds(service: any): number | null {
  const v1 = service?.spec?.template?.spec?.timeoutSeconds;
  if (typeof v1 === "number") return v1;
  if (typeof v1 === "string" && /^\d+$/.test(v1)) return Number(v1);

  const v2 = service?.template?.timeout;
  if (typeof v2 === "string") {
    const match = v2.match(/^(\d+)s$/);
    if (match) return Number(match[1]);
  }

  const v2Seconds = service?.template?.timeoutSeconds;
  if (typeof v2Seconds === "number") return v2Seconds;
  if (typeof v2Seconds === "string" && /^\d+$/.test(v2Seconds)) return Number(v2Seconds);

  return null;
}

function checkPublicInvoker(policy: any): boolean {
  const bindings = Array.isArray(policy?.bindings) ? policy.bindings : [];
  for (const binding of bindings) {
    if (binding?.role !== "roles/run.invoker") continue;
    const members = Array.isArray(binding?.members) ? binding.members : [];
    if (members.includes("allUsers")) return true;
  }
  return false;
}

function pushCheck(checks: VerificationCheck[], status: CheckStatus, name: string, detail: string): void {
  checks.push({ status, name, detail });
  const prefix = status === "pass" ? "[PASS]" : status === "warn" ? "[WARN]" : "[FAIL]";
  console.log(`${prefix} ${name}: ${detail}`);
}

function ensure(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function postJson(baseUrl: string, route: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, json: payload };
}

async function probeLive(baseUrl: string, sessionId: string): Promise<{ status: "ready" | "warn" | "fail"; detail: string }> {
  const wsUrl = `${toWsUrl(baseUrl)}/api/live`;
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "timeout");
      }
      resolve({ status: "fail", detail: "Timed out waiting for live_ready or live error response." });
    }, 20_000);

    let started = false;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "start",
          sessionId,
          userGoal: "Verifier live check",
        }),
      );
      started = true;
    });

    ws.on("message", (raw) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (parsed?.type === "live_ready") {
        clearTimeout(timeout);
        ws.send(JSON.stringify({ type: "end" }));
        ws.close(1000, "done");
        resolve({ status: "ready", detail: "Received live_ready from deployed websocket route." });
        return;
      }

      if (parsed?.type === "error") {
        clearTimeout(timeout);
        if (typeof parsed.code === "string" && LIVE_WARNING_CODES.has(parsed.code)) {
          ws.close(1000, "warn");
          resolve({
            status: "warn",
            detail: `Live route reachable, but start returned ${parsed.code}: ${parsed.message ?? "no message"}`,
          });
          return;
        }
        ws.close(1000, "fail");
        resolve({
          status: "fail",
          detail: `Live route returned error ${parsed.code ?? "unknown"}: ${parsed.message ?? "no message"}`,
        });
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        status: "fail",
        detail: `WebSocket probe failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });

    ws.on("close", () => {
      if (!started) {
        clearTimeout(timeout);
        resolve({ status: "fail", detail: "WebSocket closed before start could be sent." });
      }
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const checks: VerificationCheck[] = [];
  const baseUrl = withNoTrailingSlash(args.baseUrl);

  console.log("[verify] SilverVisit Cloud Run deployed verification");
  console.log(`[verify] baseUrl=${baseUrl}`);
  console.log(`[verify] service=${args.service} region=${args.region} project=${args.project}`);

  const healthResponse = await fetch(`${baseUrl}/health`);
  const healthPayload = await healthResponse.json().catch(() => ({}));
  if (!healthResponse.ok) {
    pushCheck(checks, "fail", "anonymous /health", `Expected 200, received ${healthResponse.status}`);
  } else {
    pushCheck(checks, "pass", "anonymous /health", "Deployed service is anonymously reachable.");
  }

  const requiredHealthFields = [
    "useVertexAI",
    "vertexConfigured",
    "liveEnabled",
    "liveApiConfigured",
    "plannerModel",
    "liveModel",
    "firestoreConfigured",
    "firestoreMode",
    "firestoreRuntimeReady",
    "googleCloudProjectConfigured",
    "googleCloudLocation",
    "httpRequestTimeoutMs",
    "httpHeadersTimeoutMs",
    "httpKeepAliveTimeoutMs",
  ];
  const missingHealth = requiredHealthFields.filter((field) => !(field in healthPayload));
  if (missingHealth.length > 0) {
    pushCheck(checks, "fail", "health truth fields", `Missing fields: ${missingHealth.join(", ")}`);
  } else {
    pushCheck(
      checks,
      "pass",
      "health truth fields",
      `Vertex=${healthPayload.vertexConfigured} Live=${healthPayload.liveApiConfigured} FirestoreMode=${healthPayload.firestoreMode}`,
    );
  }

  const sessionResult = await postJson(baseUrl, "/api/session/start", { userGoal: "Verifier deployment session start" });
  let sessionId = "";
  if (sessionResult.status !== 200 || typeof sessionResult.json?.sessionId !== "string") {
    pushCheck(checks, "fail", "POST /api/session/start", `Unexpected response status=${sessionResult.status}`);
  } else {
    sessionId = sessionResult.json.sessionId;
    pushCheck(checks, "pass", "POST /api/session/start", `sessionId=${sessionId}`);
  }

  const fixturePath = path.resolve(__dirname, "..", "fixtures", "sample-plan-request.json");
  const screenshotPath = path.resolve(__dirname, "..", "fixtures", "sample-screenshot.png");
  const fixture = parseJsonFile(fixturePath);
  const screenshotB64 = fs.readFileSync(screenshotPath).toString("base64");

  const planPayload = {
    ...fixture,
    sessionId: sessionId || `verifier-${Date.now()}`,
    requireScreenshot: true,
    screenshotBase64: screenshotB64,
    screenshotMimeType: "image/png",
  };
  const planResult = await postJson(baseUrl, "/api/plan-action", planPayload);
  if (planResult.status !== 200) {
    pushCheck(checks, "fail", "POST /api/plan-action", `Unexpected response status=${planResult.status}`);
  } else {
    const payload = planResult.json;
    const validShape =
      ALLOWED_PLAN_STATUSES.has(payload?.status) &&
      typeof payload?.message === "string" &&
      typeof payload?.action?.type === "string" &&
      Array.isArray(payload?.grounding?.matchedElementIds) &&
      Array.isArray(payload?.grounding?.matchedVisibleText);
    if (!validShape) {
      pushCheck(checks, "fail", "POST /api/plan-action", "Response does not match grounded action schema.");
    } else {
      pushCheck(
        checks,
        "pass",
        "POST /api/plan-action",
        `status=${payload.status}, action=${payload.action.type}, confidence=${payload.confidence}`,
      );
    }
  }

  const liveProbe = await probeLive(baseUrl, sessionId || `verifier-live-${Date.now()}`);
  if (liveProbe.status === "ready") {
    pushCheck(checks, "pass", "WS /api/live", liveProbe.detail);
  } else if (liveProbe.status === "warn") {
    pushCheck(checks, "warn", "WS /api/live", `${liveProbe.detail}. Remaining manual step: verify full browser Live Ready + transcript + mic turn.`);
  } else {
    pushCheck(checks, "fail", "WS /api/live", liveProbe.detail);
  }

  const describeResult = runGcloud(
    [
      "run",
      "services",
      "describe",
      args.service,
      "--project",
      args.project,
      "--region",
      args.region,
      "--platform",
      "managed",
      "--format=json",
    ],
    args.accessTokenFile,
  );
  if (describeResult.status !== 0) {
    pushCheck(checks, "fail", "Cloud Run service describe", describeResult.stderr.trim() || "gcloud describe failed");
  } else {
    const service = JSON.parse(describeResult.stdout);
    const timeoutSeconds = extractTimeoutSeconds(service);
    const serviceUrl = String(service?.status?.url ?? "");
    if (timeoutSeconds !== 900) {
      pushCheck(
        checks,
        "fail",
        "Cloud Run timeoutSeconds",
        `Expected 900, found ${timeoutSeconds === null ? "unavailable" : timeoutSeconds}`,
      );
    } else {
      pushCheck(checks, "pass", "Cloud Run timeoutSeconds", "Service timeout is 900 seconds.");
    }
    if (serviceUrl && serviceUrl !== baseUrl) {
      pushCheck(checks, "warn", "Cloud Run URL match", `Resolved service URL is ${serviceUrl}, verifier ran against ${baseUrl}`);
    } else {
      pushCheck(checks, "pass", "Cloud Run URL match", "Verifier base URL matches service URL.");
    }
  }

  const iamResult = runGcloud(
    [
      "run",
      "services",
      "get-iam-policy",
      args.service,
      "--project",
      args.project,
      "--region",
      args.region,
      "--platform",
      "managed",
      "--format=json",
    ],
    args.accessTokenFile,
  );
  if (iamResult.status !== 0) {
    pushCheck(checks, "fail", "public invoke IAM policy", iamResult.stderr.trim() || "gcloud IAM check failed");
  } else {
    const policy = JSON.parse(iamResult.stdout);
    if (!checkPublicInvoker(policy)) {
      pushCheck(checks, "fail", "public invoke IAM policy", "roles/run.invoker binding for allUsers is missing.");
    } else {
      pushCheck(checks, "pass", "public invoke IAM policy", "allUsers has roles/run.invoker.");
    }
  }

  ensure(typeof healthPayload?.httpRequestTimeoutMs === "number", "health payload missing timeout diagnostics");
  if (healthPayload.httpRequestTimeoutMs !== 0) {
    pushCheck(
      checks,
      "warn",
      "Node request timeout",
      `Expected 0 for long-lived sockets, found ${healthPayload.httpRequestTimeoutMs}`,
    );
  } else {
    pushCheck(checks, "pass", "Node request timeout", "Node request timeout does not undercut Cloud Run timeout.");
  }

  const failed = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  console.log("[verify] ----------------------------------------");
  console.log(`[verify] checks=${checks.length} pass=${checks.length - failed.length - warnings.length} warn=${warnings.length} fail=${failed.length}`);
  if (warnings.length > 0) {
    console.log("[verify] Warnings:");
    for (const warning of warnings) {
      console.log(`  - ${warning.name}: ${warning.detail}`);
    }
  }

  if (failed.length > 0) {
    console.error("[verify] Deployed verification failed.");
    process.exit(1);
  }

  console.log("[verify] Deployed verification passed.");
}

main().catch((error) => {
  console.error(`[verify] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
