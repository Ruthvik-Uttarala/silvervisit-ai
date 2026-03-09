import { ServerResponse } from "node:http";
import { AppConfig } from "../types";
import { isLiveApiConfigured, isVertexConfigured } from "../config";
import { sendJson } from "../utils";

export function handleHealth(res: ServerResponse, config: AppConfig, requestId: string): void {
  sendJson(
    res,
    200,
    {
      ok: true,
      service: "silvervisit-backend",
      liveApiConfigured: isLiveApiConfigured(config),
      vertexConfigured: isVertexConfigured(config),
    },
    requestId,
  );
}
