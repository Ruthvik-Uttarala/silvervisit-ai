import type { ActionAmount, ActionDirection, ActionObject, PageSnapshot, UIElementSnapshot } from "./types";

const HIGHLIGHT_STYLE_ID = "silvervisit-highlight-style";
const HIGHLIGHT_RING_ID = "silvervisit-highlight-ring";
const STABLE_ID_ATTR = "data-silvervisit-id";
const MAX_VISIBLE_TEXT = 180;
const MAX_VISIBLE_TEXT_LENGTH = 400;
const MAX_ELEMENTS = 120;

let removeHighlightListeners: (() => void) | null = null;

function isHTMLElement(value: Element | null): value is HTMLElement {
  return value instanceof HTMLElement;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isVisible(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function isTextInput(element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function getRole(element: HTMLElement) {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) {
    return explicitRole;
  }

  switch (element.tagName.toLowerCase()) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "input":
      return "input";
    case "textarea":
      return "textbox";
    case "select":
      return "select";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    default:
      return element.tagName.toLowerCase();
  }
}

function sanitizeIdSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function getElementText(element: HTMLElement) {
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  const placeholder = element.getAttribute("placeholder")?.trim();
  const textContent = element.innerText?.trim() || element.textContent?.trim() || "";

  if (ariaLabel) {
    return ariaLabel;
  }

  if (textContent) {
    return textContent.replace(/\s+/g, " ").slice(0, 500);
  }

  if (placeholder) {
    return placeholder;
  }

  if (isTextInput(element) && element.value.trim()) {
    return element.value.trim().slice(0, 500);
  }

  return "";
}

function getStableElementId(element: HTMLElement, index: number) {
  if (element.id) {
    return element.id;
  }

  const existing = element.getAttribute(STABLE_ID_ATTR);
  if (existing) {
    return existing;
  }

  const text = getElementText(element);
  const role = getRole(element);
  const stableId = [
    "sv",
    sanitizeIdSegment(role) || "node",
    sanitizeIdSegment(text) || "untitled",
    index.toString(36),
  ].join("-");

  element.setAttribute(STABLE_ID_ATTR, stableId);
  return stableId;
}

function collectVisibleText() {
  const results = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !isHTMLElement(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (!isVisible(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      const text = node.textContent?.replace(/\s+/g, " ").trim();
      if (!text || text.length < 2) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (results.size < MAX_VISIBLE_TEXT) {
    const node = walker.nextNode();
    if (!node) {
      break;
    }

    const text = node.textContent?.replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    results.add(text.slice(0, MAX_VISIBLE_TEXT_LENGTH));
  }

  return Array.from(results);
}

function normalizeElement(element: HTMLElement, index: number): UIElementSnapshot | null {
  if (!isVisible(element)) {
    return null;
  }

  const text = getElementText(element);
  if (!text) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const role = getRole(element);
  const baseSnapshot: UIElementSnapshot = {
    id: getStableElementId(element, index),
    text,
    role,
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
    visible: true,
    enabled: !(element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)
      ? true
      : !element.disabled,
  };

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const placeholder = "placeholder" in element ? element.placeholder?.trim() : "";
    const value = "value" in element ? String(element.value).trim() : "";
    if (placeholder) {
      baseSnapshot.placeholder = placeholder.slice(0, 1000);
    }
    if (value) {
      baseSnapshot.value = value.slice(0, 1000);
    }
  }

  return baseSnapshot;
}

function collectElements() {
  const selector = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='status']",
    "[aria-label]",
    "[data-agent-capture='true']",
  ].join(",");

  const seen = new Set<HTMLElement>();
  const elements: UIElementSnapshot[] = [];
  const candidates = Array.from(document.querySelectorAll(selector));

  for (const candidate of candidates) {
    if (!isHTMLElement(candidate) || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    const normalized = normalizeElement(candidate, elements.length);
    if (!normalized) {
      continue;
    }

    elements.push(normalized);
    if (elements.length >= MAX_ELEMENTS) {
      break;
    }
  }

  return elements;
}

function ensureHighlightStyles() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    @keyframes silvervisitPulse {
      0% {
        transform: scale(0.98);
        box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.55);
      }
      70% {
        transform: scale(1.02);
        box-shadow: 0 0 0 28px rgba(37, 99, 235, 0);
      }
      100% {
        transform: scale(0.98);
        box-shadow: 0 0 0 0 rgba(37, 99, 235, 0);
      }
    }

    #${HIGHLIGHT_RING_ID} {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      border: 5px solid #2563eb;
      border-radius: 32px;
      background: rgba(37, 99, 235, 0.08);
      animation: silvervisitPulse 1.5s ease-out infinite;
      transition:
        top 180ms ease,
        left 180ms ease,
        width 180ms ease,
        height 180ms ease;
    }
  `;

  document.head.appendChild(style);
}

function positionHighlightRing(ring: HTMLDivElement, target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const padding = 12;

  ring.style.top = `${Math.max(rect.top - padding, 0)}px`;
  ring.style.left = `${Math.max(rect.left - padding, 0)}px`;
  ring.style.width = `${rect.width + padding * 2}px`;
  ring.style.height = `${rect.height + padding * 2}px`;
}

function clearExistingHighlight() {
  removeHighlightListeners?.();
  removeHighlightListeners = null;
  document.getElementById(HIGHLIGHT_RING_ID)?.remove();
}

function scrollDeltaFor(direction: ActionDirection = "down", amount: ActionAmount = "medium") {
  const magnitude = amount === "small" ? 240 : amount === "large" ? 720 : 420;
  switch (direction) {
    case "up":
      return { top: -magnitude, left: 0 };
    case "left":
      return { top: 0, left: -magnitude };
    case "right":
      return { top: 0, left: magnitude };
    default:
      return { top: magnitude, left: 0 };
  }
}

function setInputValue(element: HTMLElement, value: string) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (element.isContentEditable) {
    element.focus();
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    return true;
  }

  return false;
}

export function collectPageSnapshot(): PageSnapshot {
  return {
    pageUrl: window.location.href,
    pageTitle: document.title,
    visibleText: collectVisibleText(),
    elements: collectElements(),
  };
}

export async function findAndHighlight(elementId: string) {
  const target = document.getElementById(elementId);
  if (!target || !isHTMLElement(target)) {
    return {
      ok: false as const,
      error: `Could not find element with id "${elementId}" on this page.`,
    };
  }

  clearExistingHighlight();
  ensureHighlightStyles();

  const rect = target.getBoundingClientRect();
  const isOffscreen =
    rect.top < 0 ||
    rect.left < 0 ||
    rect.bottom > window.innerHeight ||
    rect.right > window.innerWidth;

  if (isOffscreen) {
    target.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "center",
    });
    await delay(500);
  }

  const ring = document.createElement("div");
  ring.id = HIGHLIGHT_RING_ID;
  document.body.appendChild(ring);

  const update = () => positionHighlightRing(ring, target);
  const teardown = () => {
    window.removeEventListener("scroll", update, true);
    window.removeEventListener("resize", update);
    ring.remove();
  };

  update();
  window.addEventListener("scroll", update, true);
  window.addEventListener("resize", update);
  const timeoutId = window.setTimeout(() => {
    teardown();
    if (removeHighlightListeners === cleanup) {
      removeHighlightListeners = null;
    }
  }, 12000);

  const cleanup = () => {
    window.clearTimeout(timeoutId);
    teardown();
  };

  removeHighlightListeners = cleanup;

  return {
    ok: true as const,
    message: `Highlighted ${elementId}.`,
  };
}

export async function executeAction(action: ActionObject) {
  switch (action.type) {
    case "highlight": {
      if (!action.targetId) {
        return { ok: false as const, error: "Highlight action is missing targetId." };
      }
      return findAndHighlight(action.targetId);
    }

    case "click": {
      if (!action.targetId) {
        return { ok: false as const, error: "Click action is missing targetId." };
      }
      const target = document.getElementById(action.targetId);
      if (!target || !isHTMLElement(target)) {
        return { ok: false as const, error: `Could not find target ${action.targetId}.` };
      }
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      await delay(350);
      target.click();
      return { ok: true as const, message: `Clicked ${action.targetId}.` };
    }

    case "type": {
      if (!action.targetId || typeof action.value !== "string") {
        return { ok: false as const, error: "Type action is missing targetId or value." };
      }
      const target = document.getElementById(action.targetId);
      if (!target || !isHTMLElement(target)) {
        return { ok: false as const, error: `Could not find target ${action.targetId}.` };
      }
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      await delay(250);
      if (!setInputValue(target, action.value)) {
        return { ok: false as const, error: `Target ${action.targetId} does not accept typed input.` };
      }
      return { ok: true as const, message: `Entered text into ${action.targetId}.` };
    }

    case "scroll": {
      if (action.targetId) {
        const target = document.getElementById(action.targetId);
        if (target && isHTMLElement(target)) {
          target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          return { ok: true as const, message: `Scrolled to ${action.targetId}.` };
        }
      }

      const delta = scrollDeltaFor(action.direction, action.amount);
      window.scrollBy({ behavior: "smooth", ...delta });
      return { ok: true as const, message: "Scrolled the page." };
    }

    case "wait": {
      await delay(action.delayMs ?? 1000);
      return { ok: true as const, message: "Waited for the page to settle." };
    }

    case "ask_user":
      return { ok: true as const, message: "The agent needs clarification from the user." };

    case "done":
      return { ok: true as const, message: "The guided flow is complete." };

    default:
      return { ok: false as const, error: `Unsupported action type: ${String(action.type)}` };
  }
}
