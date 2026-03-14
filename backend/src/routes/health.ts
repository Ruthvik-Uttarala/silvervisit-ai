import { ServerResponse } from "node:http";
import { AppConfig } from "../types";
import { isVertexConfigured } from "../config";
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

  sendJson(
    res,
    200,
    {
      ok: true,
      service: "silvervisit-backend",
      liveApiConfigured,
      vertexConfigured,
    },
    requestId,
  );
}
