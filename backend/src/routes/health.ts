import { ServerResponse } from "node:http";
import { AppConfig } from "../types";
import { isGeminiApiConfigured, isVertexConfigured } from "../config";
import { getRepository } from "../repository";
import { getGeminiClient } from "../vertex";
import { sendJson } from "../utils";

export function handleHealth(res: ServerResponse, config: AppConfig, requestId: string): void {
  let aiConfigured = false;
  if (config.aiProvider === "gemini_api" ? isGeminiApiConfigured(config) : isVertexConfigured(config)) {
    try {
      getGeminiClient(config);
      aiConfigured = true;
    } catch {
      aiConfigured = false;
    }
  }

  const liveApiConfigured =
    config.enableLiveApi && config.aiProvider === "vertex" && aiConfigured && config.geminiLiveModel.trim().length > 0;
  const googleCloudProjectConfigured = config.googleCloudProject.trim().length > 0;
  const googleCloudLocation = config.googleCloudLocation.trim() || "global";
  const repository = getRepository(config);
  const repositoryDiagnostics = repository.getDiagnostics();

  sendJson(
    res,
    200,
    {
      ok: true,
      service: "silvervisit-backend",
      aiProvider: config.aiProvider,
      geminiConfigured: config.aiProvider === "gemini_api" ? aiConfigured : false,
      geminiModel: config.geminiActionModel,
      useVertexAI: config.useVertexAI,
      liveEnabled: config.enableLiveApi,
      liveApiConfigured,
      vertexConfigured: config.aiProvider === "vertex" ? aiConfigured : false,
      plannerModel: config.geminiActionModel,
      liveModel: config.geminiLiveModel,
      googleCloudProjectConfigured,
      googleCloudLocation,
      httpRequestTimeoutMs: config.httpRequestTimeoutMs,
      httpHeadersTimeoutMs: config.httpHeadersTimeoutMs,
      httpKeepAliveTimeoutMs: config.httpKeepAliveTimeoutMs,
      databaseProvider: repositoryDiagnostics.provider,
      supabaseConfigured: repositoryDiagnostics.provider === "supabase" && repositoryDiagnostics.configured,
      firestoreConfigured: repositoryDiagnostics.provider === "firestore" && repositoryDiagnostics.configured,
      firestoreMode: repositoryDiagnostics.provider === "firestore" ? repositoryDiagnostics.mode : "disabled",
      firestoreRuntimeReady: repositoryDiagnostics.provider === "firestore" && repositoryDiagnostics.runtimeReady,
      firestoreLastError:
        repositoryDiagnostics.provider === "firestore" ? repositoryDiagnostics.lastError ?? null : null,
      persistenceConfigured: repositoryDiagnostics.configured,
      persistenceRuntimeReady: repositoryDiagnostics.runtimeReady,
      persistenceLastError: repositoryDiagnostics.lastError ?? null,
    },
    requestId,
  );
}
