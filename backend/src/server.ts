import http, { IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "./config";
import { getRepository } from "./repository";
import { handleLiveSocketConnection } from "./liveSession";
import { logger } from "./logger";
import { handleHealth } from "./routes/health";
import { buildPlanActionErrorResponse, handlePlanAction } from "./routes/planAction";
import { handleSandboxFixture, handleSandboxRunEvent, handleSandboxRunStart } from "./routes/sandbox";
import { handleSessionGet, handleSessionStart } from "./routes/session";
import { sessionStore } from "./sessions";
import {
  assertJsonContentType,
  generateRequestId,
  HttpRequestError,
  readJsonBody,
  safeErrorMessage,
  sendJson,
  setCorsHeaders,
} from "./utils";

function logGoogleRuntimeConfiguration(): void {
  const config = loadConfig();
  const repository = getRepository(config);
  const diagnostics = repository.getDiagnostics();
  logger.info("Runtime configuration", {
    provider: "@google/genai",
    aiProvider: config.aiProvider,
    geminiApiConfigured: config.geminiApiKey.length > 0,
    vertexModeEnabled: config.aiProvider === "vertex",
    vertexConfigured: config.aiProvider === "vertex" && config.googleCloudProject.length > 0 && config.googleCloudLocation.length > 0,
    liveEnabled: config.enableLiveApi,
    plannerModel: config.geminiActionModel,
    liveModel: config.geminiLiveModel,
    googleCloudProjectConfigured: config.googleCloudProject.length > 0,
    googleCloudLocation: config.googleCloudLocation,
    httpRequestTimeoutMs: config.httpRequestTimeoutMs,
    httpHeadersTimeoutMs: config.httpHeadersTimeoutMs,
    httpKeepAliveTimeoutMs: config.httpKeepAliveTimeoutMs,
    databaseProvider: diagnostics.provider,
    persistenceConfigured: diagnostics.configured,
    persistenceMode: diagnostics.mode,
  });
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = loadConfig();
  const repository = getRepository(config);
  const requestIdHeader = req.headers["x-request-id"];
  const requestId = typeof requestIdHeader === "string" && requestIdHeader.trim() ? requestIdHeader : generateRequestId();

  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  setCorsHeaders(res, origin);

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
    if (method === "GET" && pathname === "/") {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: "silvervisit-backend",
          message:
            "SilverVisit backend is running. Use /health for status. Use the Chrome extension on a supported telehealth page for live navigation.",
          health: "/health",
        },
        requestId,
      );
      return;
    }

    if (method === "GET" && pathname === "/health") {
      handleHealth(res, config, requestId);
      return;
    }

    if (method === "POST" && pathname === "/api/session/start") {
      const body = await readJsonBody(req, config.maxRequestBytes);
      handleSessionStart(res, body, requestId, sessionStore, logger, repository);
      return;
    }

    if (method === "GET" && pathname.startsWith("/api/session/")) {
      const sessionId = pathname.slice("/api/session/".length).trim();
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." }, requestId);
        return;
      }
      await handleSessionGet(res, requestId, sessionId, sessionStore, repository);
      return;
    }

    if (method === "GET" && pathname === "/api/sandbox/fixture") {
      const seedQuery = parsedUrl.searchParams.get("seed");
      const seed = seedQuery ? Number(seedQuery) : undefined;
      await handleSandboxFixture(res, requestId, repository, seed);
      return;
    }

    if (method === "POST" && pathname === "/api/sandbox/run/start") {
      assertJsonContentType(req);
      const body = await readJsonBody(req, config.maxRequestBytes);
      await handleSandboxRunStart(res, body, requestId, repository, logger);
      return;
    }

    if (method === "POST" && pathname === "/api/sandbox/run/event") {
      assertJsonContentType(req);
      const body = await readJsonBody(req, config.maxRequestBytes);
      await handleSandboxRunEvent(res, body, requestId, repository);
      return;
    }

    if (method === "POST" && pathname === "/api/plan-action") {
      assertJsonContentType(req);
      const body = await readJsonBody(req, config.maxRequestBytes);
      await handlePlanAction(res, body, requestId, sessionStore, config, logger, repository);
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
    logger.error("HTTP request failed", {
      requestId,
      method,
      path: pathname,
      error: message,
    });

    if (method === "POST" && pathname === "/api/plan-action") {
      if (error instanceof HttpRequestError) {
        sendJson(res, error.statusCode, buildPlanActionErrorResponse(error.message, "error"), requestId);
        return;
      }

      sendJson(
        res,
        500,
        buildPlanActionErrorResponse("Internal server error while planning next action.", "error"),
        requestId,
      );
      return;
    }

    if (error instanceof HttpRequestError) {
      sendJson(res, error.statusCode, { error: error.message }, requestId);
      return;
    }

    sendJson(res, 500, { error: message }, requestId);
  }
}

export function createAppServer(): { server: Server; wss: WebSocketServer } {
  const config = loadConfig();
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res);
  });
  server.requestTimeout = config.httpRequestTimeoutMs;
  server.headersTimeout = config.httpHeadersTimeoutMs;
  server.keepAliveTimeout = config.httpKeepAliveTimeoutMs;
  server.timeout = 0;

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
    const repository = getRepository(config);
    handleLiveSocketConnection(ws, req, {
      config,
      logger,
      sessions: sessionStore,
      firestore: repository,
      requestId,
    });
  });

  return { server, wss };
}

export async function startServer(port = loadConfig().port): Promise<RunningServer> {
  logGoogleRuntimeConfiguration();
  sessionStore.startCleanup();
  const config = loadConfig();
  const repository = getRepository(config);
  const diagnostics = repository.getDiagnostics();
  if (diagnostics.configured) {
    try {
      const seededCount = await repository.ensureDeterministicFixtures();
      logger.info("Repository fixture bootstrap complete", {
        databaseProvider: diagnostics.provider,
        persistenceMode: diagnostics.mode,
        seededCount,
      });
    } catch (error) {
      repository.markUnavailable(error);
      logger.error("Repository bootstrap failed; runtime marked unavailable", {
        databaseProvider: diagnostics.provider,
        persistenceMode: diagnostics.mode,
        error: safeErrorMessage(error),
      });
    }
  }

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
  logger.info("HTTP timeout configuration applied", {
    requestTimeoutMs: config.httpRequestTimeoutMs,
    headersTimeoutMs: config.httpHeadersTimeoutMs,
    keepAliveTimeoutMs: config.httpKeepAliveTimeoutMs,
    socketTimeoutMs: server.timeout,
  });

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
