import { GoogleGenAI } from "@google/genai";
import { AppConfig } from "./types";
import { isGeminiApiConfigured, isVertexConfigured } from "./config";

let cachedVertexClient: GoogleGenAI | null = null;
let cachedVertexKey = "";
let cachedGeminiApiClient: GoogleGenAI | null = null;
let cachedGeminiApiKeyFingerprint = "";

function fingerprintSecret(value: string): string {
  return `${value.length}:${value.slice(0, 4)}`;
}

export function getGeminiClient(config: AppConfig): GoogleGenAI {
  if (config.aiProvider === "vertex") {
    return getVertexClient(config);
  }

  if (!isGeminiApiConfigured(config)) {
    throw new Error("Gemini Developer API is not configured. Set GEMINI_API_KEY server-side.");
  }

  const key = fingerprintSecret(config.geminiApiKey);
  if (cachedGeminiApiClient && cachedGeminiApiKeyFingerprint === key) {
    return cachedGeminiApiClient;
  }

  cachedGeminiApiClient = new GoogleGenAI({
    apiKey: config.geminiApiKey,
  });
  cachedGeminiApiKeyFingerprint = key;
  return cachedGeminiApiClient;
}

export function getVertexClient(config: AppConfig): GoogleGenAI {
  if (!isVertexConfigured(config)) {
    throw new Error(
      "Vertex AI is not configured. Set GOOGLE_GENAI_USE_VERTEXAI=true, GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION.",
    );
  }

  const key = `${config.googleCloudProject}:${config.googleCloudLocation}`;
  if (cachedVertexClient && cachedVertexKey === key) {
    return cachedVertexClient;
  }

  cachedVertexClient = new GoogleGenAI({
    vertexai: true,
    project: config.googleCloudProject,
    location: config.googleCloudLocation,
  });
  cachedVertexKey = key;
  return cachedVertexClient;
}
