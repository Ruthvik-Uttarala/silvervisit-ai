import type {
  ActiveTabInfo,
  ActionObject,
  BackgroundMessage,
  BackgroundResponse,
  ContentScriptMessage,
  ContentScriptResponse,
  PageSnapshot,
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
    url: tab.url,
    title: tab.title,
  };
}

async function sendToActiveTab(message: ContentScriptMessage) {
  const tab = await getActiveTab();
  const response = (await chrome.tabs.sendMessage(tab.tabId, message)) as ContentScriptResponse;
  return { tab, response };
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
