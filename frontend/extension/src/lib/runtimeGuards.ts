export type SupportStatus = "unknown" | "supported" | "unsupported";

export interface SupportState {
  status: SupportStatus;
  activeUrl?: string;
  reason?: string;
  generation: number;
}

export interface TurnGenerationToken {
  tabGeneration: number;
  snapshotGeneration: number;
  tabUrl: string;
}

export interface TurnGenerationSource {
  tabGeneration: number;
  snapshotGeneration: number;
  tabUrl: string;
}

export interface SupportTransitionResult {
  next: SupportState;
  changed: boolean;
  becameSupported: boolean;
  becameUnsupported: boolean;
}

function normalizedUrl(url?: string): string {
  return (url ?? "").trim();
}

export function reconcileSupportState(
  previous: SupportState,
  nextStatus: SupportStatus,
  url?: string,
  reason?: string,
): SupportTransitionResult {
  const nextUrl = normalizedUrl(url);
  const prevUrl = normalizedUrl(previous.activeUrl);
  const changed = previous.status !== nextStatus || prevUrl !== nextUrl || (previous.reason ?? "") !== (reason ?? "");
  if (!changed) {
    return {
      next: previous,
      changed: false,
      becameSupported: false,
      becameUnsupported: false,
    };
  }

  return {
    next: {
      status: nextStatus,
      activeUrl: nextUrl || undefined,
      reason: reason || undefined,
      generation: previous.generation + 1,
    },
    changed: true,
    becameSupported: previous.status !== "supported" && nextStatus === "supported",
    becameUnsupported: previous.status !== "unsupported" && nextStatus === "unsupported",
  };
}

export function createTurnGenerationToken(source: TurnGenerationSource): TurnGenerationToken {
  return {
    tabGeneration: source.tabGeneration,
    snapshotGeneration: source.snapshotGeneration,
    tabUrl: source.tabUrl,
  };
}

export function isTurnGenerationCurrent(
  token: TurnGenerationToken,
  source: TurnGenerationSource,
): boolean {
  return (
    token.tabGeneration === source.tabGeneration &&
    token.snapshotGeneration === source.snapshotGeneration &&
    token.tabUrl === source.tabUrl
  );
}

export function shouldApplyLiveGenerationEvent(eventGeneration: number, currentGeneration: number): boolean {
  return eventGeneration === currentGeneration && eventGeneration > 0;
}
