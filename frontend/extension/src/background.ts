import type {
  ActiveTabInfo,
  ActionObject,
  BackgroundMessage,
  BackgroundResponse,
  ContentScriptMessage,
  ContentScriptResponse,
  PageContextWithScreenshot,
  PageSnapshot,
  ScreenshotCapture,
} from "./lib/types";

const CAPTURE_COOLDOWN_MS = 900;
const SUPPORTED_LOCAL_PORT = "4173";
let captureInFlight: Promise<string> | null = null;
let lastCapturedAt = 0;
let lastCaptureDataUrl: string | null = null;

async function enablePanelOnActionClick() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error(`[SilverVisit] Failed to configure side panel behavior: ${toErrorMessage(error)}`);
  }
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isSnapshotResponse(
  response: ContentScriptResponse,
): response is { ok: true; snapshot: PageSnapshot } {
  return response.ok && "snapshot" in response;
}

function isMessageResponse(response: ContentScriptResponse): response is { ok: true; message: string } {
  return response.ok && "message" in response;
}

async function getActiveTab(): Promise<ActiveTabInfo> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    throw new Error("Open the Sandbox Dashboard in an active browser tab first.");
  }

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
  };
}

function isSupportedTelehealthUrl(url?: string): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return parsed.port === SUPPORTED_LOCAL_PORT;
    }
    return host.includes("silvervisit");
  } catch {
    return false;
  }
}

function normalizeUrlForMatch(url?: string): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

async function validateExecutionTab(expectedTabId?: number, expectedUrl?: string): Promise<string | null> {
  const activeTab = await getActiveTab();
  if (typeof expectedTabId === "number" && activeTab.tabId !== expectedTabId) {
    return `Active tab changed before execution (expected tab ${expectedTabId}, found ${activeTab.tabId}).`;
  }
  if (typeof expectedUrl === "string" && expectedUrl.trim()) {
    const expectedNormalized = normalizeUrlForMatch(expectedUrl);
    const activeNormalized = normalizeUrlForMatch(activeTab.url);
    if (expectedNormalized && activeNormalized && expectedNormalized !== activeNormalized) {
      return `Active page changed before execution (${activeTab.url ?? "unknown URL"}).`;
    }
  }
  if (!isSupportedTelehealthUrl(activeTab.url)) {
    return `Execution blocked on unsupported page (${activeTab.url ?? "unknown URL"}). Return to the SilverVisit telehealth app.`;
  }
  return null;
}

async function ensureMessageChannel(tabId: number, message: ContentScriptMessage): Promise<ContentScriptResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as ContentScriptResponse;
  } catch (error) {
    const messageText = toErrorMessage(error);
    const canRetry =
      messageText.includes("Receiving end does not exist") ||
      messageText.includes("Could not establish connection");
    if (!canRetry) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["assets/content.js"],
    });
    return (await chrome.tabs.sendMessage(tabId, message)) as ContentScriptResponse;
  }
}

async function sendToActiveTab(message: ContentScriptMessage) {
  const tab = await getActiveTab();
  const response = await ensureMessageChannel(tab.tabId, message);
  return { tab, response };
}

function parseCaptureDataUrl(dataUrl: string): ScreenshotCapture {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i);
  if (!match) {
    throw new Error("Failed to capture a valid screenshot from the active tab.");
  }

  const mimeType = match[1].toLowerCase() as ScreenshotCapture["mimeType"];
  const base64 = match[2].replace(/\s+/g, "");
  if (!base64) {
    throw new Error("Captured screenshot was empty.");
  }

  try {
    const binary = atob(base64);
    if (!binary || binary.length === 0) {
      throw new Error("Screenshot decoded to empty bytes.");
    }
  } catch {
    throw new Error("Captured screenshot is not valid base64 image data.");
  }

  return { mimeType, base64 };
}

async function captureVisibleTabScreenshot(windowId?: number): Promise<string> {
  if (captureInFlight) {
    return captureInFlight;
  }

  const now = Date.now();
  if (lastCaptureDataUrl && now - lastCapturedAt < CAPTURE_COOLDOWN_MS) {
    return lastCaptureDataUrl;
  }

  captureInFlight = new Promise<string>((resolve, reject) => {
    const executeCapture = () => {
      const callback = (dataUrl?: string) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          captureInFlight = null;
          reject(new Error(lastError.message));
          return;
        }
        if (!dataUrl) {
          captureInFlight = null;
          reject(new Error("Screenshot capture returned empty data."));
          return;
        }
        lastCapturedAt = Date.now();
        lastCaptureDataUrl = dataUrl;
        captureInFlight = null;
        resolve(dataUrl);
      };

      if (typeof windowId === "number") {
        chrome.tabs.captureVisibleTab(windowId, { format: "png" }, callback);
        return;
      }

      chrome.tabs.captureVisibleTab({ format: "png" }, callback);
    };

    const delayMs = Math.max(0, CAPTURE_COOLDOWN_MS - (Date.now() - lastCapturedAt));
    if (delayMs > 0) {
      setTimeout(executeCapture, delayMs);
      return;
    }
    executeCapture();
  });

  return captureInFlight;
}

async function collectContextWithScreenshot(): Promise<PageContextWithScreenshot> {
  const tab = await getActiveTab();
  const snapshotResponse = await ensureMessageChannel(tab.tabId, { type: "COLLECT_PAGE_STATE" });
  if (!snapshotResponse.ok) {
    throw new Error(snapshotResponse.error);
  }
  if (!isSnapshotResponse(snapshotResponse)) {
    throw new Error("Content script returned an invalid snapshot response.");
  }

  const dataUrl = await captureVisibleTabScreenshot(tab.windowId);
  const screenshot = parseCaptureDataUrl(dataUrl);
  console.info("[SilverVisit] Screenshot capture success", {
    tabId: tab.tabId,
    mimeType: screenshot.mimeType,
  });

  return {
    tab,
    snapshot: snapshotResponse.snapshot,
    screenshot,
  };
}

function toContentScriptMessage(action: ActionObject): ContentScriptMessage {
  if (action.type === "highlight" && action.targetId) {
    return { type: "HIGHLIGHT", id: action.targetId };
  }

  return { type: "EXECUTE_ACTION", action };
}

chrome.runtime.onInstalled.addListener(() => {
  void enablePanelOnActionClick();
});

chrome.runtime.onStartup.addListener(() => {
  void enablePanelOnActionClick();
});

void enablePanelOnActionClick();

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  const respond = (response: BackgroundResponse) => sendResponse(response);

  (async () => {
    try {
      switch (message.type) {
        case "GET_ACTIVE_TAB": {
          const tab = await getActiveTab();
          respond({ ok: true, tab });
          return;
        }

        case "COLLECT_PAGE_STATE": {
          const { response } = await sendToActiveTab({ type: "COLLECT_PAGE_STATE" });
          if (!response.ok) {
            respond({ ok: false, error: response.error });
            return;
          }
          if (!isSnapshotResponse(response)) {
            respond({ ok: false, error: "Content script returned an invalid snapshot response." });
            return;
          }
          respond({ ok: true, snapshot: response.snapshot });
          return;
        }

        case "COLLECT_CONTEXT_WITH_SCREENSHOT": {
          const context = await collectContextWithScreenshot();
          respond({ ok: true, context });
          return;
        }

        case "PING_CONTENT_SCRIPT": {
          const { response } = await sendToActiveTab({ type: "PING" });
          if (!response.ok) {
            respond({ ok: false, error: response.error });
            return;
          }
          if (!isMessageResponse(response)) {
            respond({ ok: false, error: "Content script returned an invalid ping response." });
            return;
          }
          respond({ ok: true, message: response.message });
          return;
        }

        case "HIGHLIGHT": {
          const mismatch = await validateExecutionTab(message.expectedTabId, message.expectedUrl);
          if (mismatch) {
            respond({ ok: false, error: mismatch });
            return;
          }
          const { response } = await sendToActiveTab({ type: "HIGHLIGHT", id: message.id });
          if (!response.ok) {
            respond({ ok: false, error: response.error });
            return;
          }
          if (!isMessageResponse(response)) {
            respond({ ok: false, error: "Content script returned an invalid highlight response." });
            return;
          }
          respond({ ok: true, message: response.message });
          return;
        }

        case "EXECUTE_ACTION": {
          const mismatch = await validateExecutionTab(message.expectedTabId, message.expectedUrl);
          if (mismatch) {
            respond({ ok: false, error: mismatch });
            return;
          }
          const { response } = await sendToActiveTab(toContentScriptMessage(message.action));
          if (!response.ok) {
            respond({ ok: false, error: response.error });
            return;
          }
          if (!isMessageResponse(response)) {
            respond({ ok: false, error: "Content script returned an invalid action response." });
            return;
          }
          respond({ ok: true, message: response.message });
          return;
        }

        default:
          respond({ ok: false, error: `Unsupported background message type: ${String((message as { type?: string }).type)}` });
      }
    } catch (error) {
      console.error(
        `[SilverVisit] Background message failure type=${message.type} error=${toErrorMessage(error)}`,
      );
      respond({
        ok: false,
        error: toErrorMessage(error),
      });
    }
  })();

  return true;
});
