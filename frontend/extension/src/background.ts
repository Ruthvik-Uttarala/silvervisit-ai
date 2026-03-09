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

async function enablePanelOnActionClick() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error("Failed to configure side panel behavior", error);
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown extension error";
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
  const base64 = match[2];
  if (!base64) {
    throw new Error("Captured screenshot was empty.");
  }

  return { mimeType, base64 };
}

async function captureVisibleTabScreenshot(windowId?: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const callback = (dataUrl?: string) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!dataUrl) {
        reject(new Error("Screenshot capture returned empty data."));
        return;
      }
      resolve(dataUrl);
    };

    if (typeof windowId === "number") {
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }, callback);
      return;
    }

    chrome.tabs.captureVisibleTab({ format: "png" }, callback);
  });
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

        case "HIGHLIGHT": {
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
      respond({
        ok: false,
        error: toErrorMessage(error),
      });
    }
  })();

  return true;
});
