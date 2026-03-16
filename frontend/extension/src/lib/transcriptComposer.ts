const MAX_COMPOSER_LENGTH = 1000;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampComposerLength(value: string): string {
  if (value.length <= MAX_COMPOSER_LENGTH) {
    return value;
  }
  return value.slice(value.length - MAX_COMPOSER_LENGTH);
}

function findOverlapSuffixPrefix(base: string, next: string): number {
  const baseLower = base.toLowerCase();
  const nextLower = next.toLowerCase();
  const max = Math.min(baseLower.length, nextLower.length);
  for (let length = max; length > 0; length -= 1) {
    if (baseLower.endsWith(nextLower.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

export function appendTranscriptSegment(baseComposer: string, rawSegment: string): string {
  const base = normalizeWhitespace(baseComposer);
  const segment = normalizeWhitespace(rawSegment);
  if (!segment) {
    return base;
  }
  if (!base) {
    return clampComposerLength(segment);
  }

  const baseLower = base.toLowerCase();
  const segmentLower = segment.toLowerCase();

  if (baseLower.endsWith(segmentLower)) {
    return base;
  }

  if (segmentLower.length >= 8 && baseLower.includes(segmentLower)) {
    return base;
  }

  const overlap = findOverlapSuffixPrefix(base, segment);
  const suffix = segment.slice(overlap).trimStart();
  if (!suffix) {
    return base;
  }

  const needsSpace = !base.endsWith(" ") && !suffix.startsWith("'");
  const merged = `${base}${needsSpace ? " " : ""}${suffix}`;
  return clampComposerLength(normalizeWhitespace(merged));
}

export function composeSpeechResult(
  currentComposer: string,
  finalSegment: string,
  interimSegment: string,
): { nextComposer: string; pendingInterim: string } {
  const withFinal = appendTranscriptSegment(currentComposer, finalSegment);
  return {
    nextComposer: withFinal,
    pendingInterim: normalizeWhitespace(interimSegment),
  };
}

export function flushPendingInterim(currentComposer: string, pendingInterim: string): string {
  return appendTranscriptSegment(currentComposer, pendingInterim);
}

export function normalizeTranscriptFingerprint(segment: string): string {
  return normalizeWhitespace(segment).toLowerCase();
}

export function toSpeechResultStrings(results: Array<{ transcript: string; isFinal: boolean }>): {
  finalText: string;
  interimText: string;
} {
  let finalText = "";
  let interimText = "";
  for (const item of results) {
    if (!item.transcript) {
      continue;
    }
    if (item.isFinal) {
      finalText = appendTranscriptSegment(finalText, item.transcript);
    } else {
      interimText = appendTranscriptSegment(interimText, item.transcript);
    }
  }
  return {
    finalText,
    interimText,
  };
}
