import { collectPageSnapshot, executeAction, findAndHighlight } from "./lib/pageSnapshot";
import type { ContentScriptMessage, ContentScriptResponse } from "./lib/types";

async function handleMessage(message: ContentScriptMessage): Promise<ContentScriptResponse> {
  switch (message.type) {
    case "PING":
      return {
        ok: true,
        message: "Content script is ready.",
      };

    case "COLLECT_PAGE_STATE":
      return {
        ok: true,
        snapshot: collectPageSnapshot(),
      };

    case "HIGHLIGHT": {
      const result = await findAndHighlight(message.id);
      return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
    }

    case "EXECUTE_ACTION": {
      const result = await executeAction(message.action);
      return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
    }

    default:
      return {
        ok: false,
        error: `Unsupported message type: ${String((message as { type?: string }).type)}`,
      };
  }
}

chrome.runtime.onMessage.addListener((message: ContentScriptMessage, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error: Error) =>
      sendResponse({
        ok: false,
        error: error.message,
      }),
    );

  return true;
});
