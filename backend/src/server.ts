import http, { IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "./config";
import { handleLiveSocketConnection } from "./liveSession";
import { logger } from "./logger";
import { sessionStore } from "./sessions";
import { handleHealth } from "./routes/health";
import { handlePlanAction } from "./routes/planAction";
import { handleSessionStart } from "./routes/session";
import { generateRequestId, readJsonBody, safeErrorMessage, sendJson, setCorsHeaders } from "./utils";

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function planActionErrorShape(message: string) {
  return {
    status: "error" as const,
    message,
    action: { type: "ask_user" as const },
    confidence: 0,
    grounding: {
      matchedElementIds: [],
      matchedVisibleText: [],
      reasoningSummary: message,
    },
  };
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = loadConfig();
  const requestIdHeader = req.headers["x-request-id"];
  const requestId = typeof requestIdHeader === "string" && requestIdHeader.trim() ? requestIdHeader : generateRequestId();

  setCorsHeaders(res);

  const method = req.method ?? "GET";
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = parsedUrl.pathname;

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  logger.info("HTTP request received", {
    requestId,
    method,
    path: pathname,
  });

  try {
    if (method === "GET" && pathname === "/health") {
      handleHealth(res, config, requestId);
      return;
    }

    if (method === "POST" && pathname === "/api/session/start") {
      const body = await readJsonBody(req, config.maxRequestBytes);
      handleSessionStart(res, body, requestId, sessionStore, logger);
      return;
    }

    if (method === "POST" && pathname === "/api/plan-action") {
      const body = await readJsonBody(req, config.maxRequestBytes);
      await handlePlanAction(res, body, requestId, sessionStore, config, logger);
      return;
    }

    sendJson(
      res,
      404,
      {
        error: "Route not found",
      },
      requestId,
    );
  } catch (error) {
    const message = safeErrorMessage(error);
    const isBodyError = message.includes("Invalid JSON") || message.includes("Request body exceeds");
    logger.error("HTTP request failed", {
      requestId,
      method,
      path: pathname,
      error: message,
    });
    if (method === "POST" && pathname === "/api/plan-action") {
      sendJson(res, isBodyError ? 400 : 500, planActionErrorShape(message), requestId);
      return;
    }

    sendJson(res, isBodyError ? 400 : 500, { error: message }, requestId);
  }
}

export function createAppServer(): { server: Server; wss: WebSocketServer } {
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestId = generateRequestId();
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    if (parsedUrl.pathname !== "/api/live") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, requestId);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage, requestId: string) => {
    const config = loadConfig();
    handleLiveSocketConnection(ws, req, {
      config,
      logger,
      sessions: sessionStore,
      requestId,
    });
  });

  return { server, wss };
}

export async function startServer(port = loadConfig().port): Promise<RunningServer> {
  sessionStore.startCleanup();

  const { server, wss } = createAppServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  logger.info("Server started", { port: resolvedPort });

  return {
    server,
    port: resolvedPort,
    close: async () => {
      wss.clients.forEach((client) => client.close(1001, "server shutdown"));
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      sessionStore.stopCleanup();
    },
  };
}

if (require.main === module) {
  void startServer().catch((error) => {
    logger.error("Fatal server startup error", { error: safeErrorMessage(error) });
    process.exit(1);
  });
}
