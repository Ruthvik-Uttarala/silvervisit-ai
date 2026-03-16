const SUPPORTED_LOCAL_PORT = "4173";

export function isSupportedTelehealthUrl(url?: string): boolean {
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

export function getSupportedSandboxPort(): string {
  return SUPPORTED_LOCAL_PORT;
}

export function buildUnsupportedPageReason(url?: string): string {
  const shownUrl = url?.trim() || "unknown URL";
  return `You're currently on a non-telehealth page (${shownUrl}). Please return to the SilverVisit telehealth app tab on port ${SUPPORTED_LOCAL_PORT} so I can continue helping safely.`;
}
