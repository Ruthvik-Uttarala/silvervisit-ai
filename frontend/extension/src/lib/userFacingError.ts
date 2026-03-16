function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizeUserFacingError(message: string, fallback = "Something went wrong. Please try again."): string {
  const firstLine = String(message ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

  let cleaned = firstLine.replace(/^error:\s*/i, "");
  cleaned = cleaned.replace(/\s+at\s+[A-Za-z0-9_.<>$]+.*$/g, "");
  cleaned = collapseWhitespace(cleaned);

  if (!cleaned) {
    return fallback;
  }

  if (/webpack|vite|bundle|minified|chunk-\w+/i.test(cleaned)) {
    return fallback;
  }

  if (cleaned.length > 220) {
    cleaned = `${cleaned.slice(0, 217)}...`;
  }

  return cleaned;
}

export function toUserFacingError(error: unknown, fallback?: string): string {
  if (error instanceof Error) {
    return sanitizeUserFacingError(error.message, fallback);
  }
  if (typeof error === "string") {
    return sanitizeUserFacingError(error, fallback);
  }
  try {
    return sanitizeUserFacingError(JSON.stringify(error), fallback);
  } catch {
    return sanitizeUserFacingError(String(error), fallback);
  }
}
