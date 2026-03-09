import { GoogleGenAI } from "@google/genai";
import { AppConfig } from "./types";
import { isVertexConfigured } from "./config";

let cachedClient: GoogleGenAI | null = null;
let cachedKey = "";

export function getVertexClient(config: AppConfig): GoogleGenAI {
  if (!isVertexConfigured(config)) {
    throw new Error(
      "Vertex AI is not configured. Set GOOGLE_GENAI_USE_VERTEXAI=true, GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION.",
    );
  }

  const key = `${config.googleCloudProject}:${config.googleCloudLocation}`;
  if (cachedClient && cachedKey === key) {
    return cachedClient;
  }

  cachedClient = new GoogleGenAI({
    vertexai: true,
    project: config.googleCloudProject,
    location: config.googleCloudLocation,
  });
  cachedKey = key;
  return cachedClient;
}
