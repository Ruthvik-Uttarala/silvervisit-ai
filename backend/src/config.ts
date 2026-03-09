import { AppConfig } from "./types";

const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const useVertexAI = parseBool(env.GOOGLE_GENAI_USE_VERTEXAI, true);
  const googleCloudProject = (env.GOOGLE_CLOUD_PROJECT ?? "").trim();
  const googleCloudLocation = (env.GOOGLE_CLOUD_LOCATION ?? "global").trim() || "global";

  return {
    port: parsePort(env.PORT),
    useVertexAI,
    googleCloudProject,
    googleCloudLocation,
    geminiActionModel: (env.GEMINI_ACTION_MODEL ?? "gemini-2.5-flash").trim() || "gemini-2.5-flash",
    geminiLiveModel:
      (env.GEMINI_LIVE_MODEL ?? "gemini-live-2.5-flash-native-audio").trim() ||
      "gemini-live-2.5-flash-native-audio",
    enableLiveApi: parseBool(env.ENABLE_LIVE_API, false),
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
  };
}

export function isVertexConfigured(config: AppConfig): boolean {
  return config.useVertexAI && config.googleCloudProject.length > 0 && config.googleCloudLocation.length > 0;
}

export function isLiveApiConfigured(config: AppConfig): boolean {
  return config.enableLiveApi && isVertexConfigured(config);
}
