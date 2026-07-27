const SUPPORTED_LOCAL_PORT = "4173";

function getEnv(): Record<string, string | boolean | undefined> {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  if (viteEnv) {
    return viteEnv;
  }
  return typeof process === "undefined" ? {} : process.env;
}

function configuredProductionOrigins(): Set<string> {
  const rawValue = getEnv().VITE_SUPPORTED_PORTAL_ORIGINS;
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  return new Set(
    raw
      .split(",")
      .map((item: string) => item.trim().replace(/\/+$/, ""))
      .filter((item: string) => item.length > 0),
  );
}

export function isSupportedTelehealthUrl(url?: string): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const origin = parsed.origin.replace(/\/+$/, "");
    const devMode = getEnv().DEV === true || getEnv().DEV === "true";
    if (devMode && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
      return parsed.port === SUPPORTED_LOCAL_PORT;
    }
    return configuredProductionOrigins().has(origin);
  } catch {
    return false;
  }
}

export function getSupportedSandboxPort(): string {
  return SUPPORTED_LOCAL_PORT;
}

export function buildUnsupportedPageReason(url?: string): string {
  const shownUrl = url?.trim() || "unknown URL";
  const configured = [...configuredProductionOrigins()];
  const target = configured[0] ?? `the configured SilverVisit portal`;
  return `You're currently on an unsupported page (${shownUrl}). Please return to ${target} so I can continue safely.`;
}
