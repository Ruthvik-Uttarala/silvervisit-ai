import { ServerResponse } from "node:http";
import { AppConfig } from "../types";
import { isVertexConfigured } from "../config";
import { getFirestoreRepository } from "../firestore";
import { getVertexClient } from "../vertex";
import { sendJson } from "../utils";

export function handleHealth(res: ServerResponse, config: AppConfig, requestId: string): void {
  let vertexConfigured = false;
  if (isVertexConfigured(config)) {
    try {
      getVertexClient(config);
      vertexConfigured = true;
    } catch {
      vertexConfigured = false;
    }
  }

  const liveApiConfigured = config.enableLiveApi && vertexConfigured && config.geminiLiveModel.trim().length > 0;
  const googleCloudProjectConfigured = config.googleCloudProject.trim().length > 0;
  const googleCloudLocation = config.googleCloudLocation.trim() || "global";
  const firestore = getFirestoreRepository(config);
  const firestoreDiagnostics = firestore.getDiagnostics();

  sendJson(
    res,
    200,
    {
      ok: true,
      service: "silvervisit-backend",
      useVertexAI: config.useVertexAI,
      liveEnabled: config.enableLiveApi,
      liveApiConfigured,
      vertexConfigured,
      plannerModel: config.geminiActionModel,
      liveModel: config.geminiLiveModel,
      googleCloudProjectConfigured,
      googleCloudLocation,
      firestoreConfigured: firestoreDiagnostics.configured,
      firestoreMode: firestoreDiagnostics.mode,
      firestoreRuntimeReady: firestoreDiagnostics.runtimeReady,
      firestoreLastError: firestoreDiagnostics.lastError ?? null,
    },
    requestId,
  );
}
