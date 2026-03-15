import fs from "node:fs";
import path from "node:path";
import { AppConfig } from "./types";

const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 0;
const DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS = 65_000;
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 70_000;

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const lowered = value.trim().toLowerCase();
  if (lowered === "true") {
    return true;
  }
  if (lowered === "false") {
    return false;
  }
  return defaultValue;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 8080;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return 8080;
  }
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const text = fs.readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }

  return out;
}

function resolveEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const cwdEnv = parseDotEnvFile(path.resolve(process.cwd(), ".env"));
  const backendEnv = parseDotEnvFile(path.resolve(process.cwd(), "backend", ".env"));

  return {
    ...cwdEnv,
    ...backendEnv,
    ...env,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const resolvedEnv = resolveEnv(env);
  const useVertexAI = parseBool(resolvedEnv.GOOGLE_GENAI_USE_VERTEXAI, true);
  const googleCloudProject = (resolvedEnv.GOOGLE_CLOUD_PROJECT ?? "").trim();
  const googleCloudLocation = (resolvedEnv.GOOGLE_CLOUD_LOCATION ?? "global").trim() || "global";
  const httpRequestTimeoutMs = parseNonNegativeInt(
    resolvedEnv.HTTP_REQUEST_TIMEOUT_MS,
    DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  );
  const httpKeepAliveTimeoutMs = parseNonNegativeInt(
    resolvedEnv.HTTP_KEEPALIVE_TIMEOUT_MS,
    DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS,
  );
  const configuredHeadersTimeoutMs = parseNonNegativeInt(
    resolvedEnv.HTTP_HEADERS_TIMEOUT_MS,
    DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
  );
  const httpHeadersTimeoutMs = Math.max(configuredHeadersTimeoutMs, httpKeepAliveTimeoutMs + 1_000);

  return {
    port: parsePort(resolvedEnv.PORT),
    useVertexAI,
    googleCloudProject,
    googleCloudLocation,
    geminiActionModel: (resolvedEnv.GEMINI_ACTION_MODEL ?? "gemini-2.5-flash").trim() || "gemini-2.5-flash",
    geminiLiveModel:
      (resolvedEnv.GEMINI_LIVE_MODEL ?? "gemini-live-2.5-flash-native-audio").trim() ||
      "gemini-live-2.5-flash-native-audio",
    enableLiveApi: parseBool(resolvedEnv.ENABLE_LIVE_API, false),
    enableFirestore: parseBool(resolvedEnv.ENABLE_FIRESTORE, true),
    firestoreCollectionPrefix: (resolvedEnv.FIRESTORE_COLLECTION_PREFIX ?? "silvervisit").trim() || "silvervisit",
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
    httpRequestTimeoutMs,
    httpHeadersTimeoutMs,
    httpKeepAliveTimeoutMs,
  };
}

export function isVertexConfigured(config: AppConfig): boolean {
  return config.useVertexAI && config.googleCloudProject.length > 0 && config.googleCloudLocation.length > 0;
}

export function isLiveApiConfigured(config: AppConfig): boolean {
  return config.enableLiveApi && isVertexConfigured(config);
}
