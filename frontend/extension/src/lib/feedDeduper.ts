export interface FeedDeduperState {
  key: string;
  at: number;
}

export function shouldEmitFeedEntry(
  previous: FeedDeduperState,
  key: string,
  now: number,
  cooldownMs: number,
): { emit: boolean; next: FeedDeduperState } {
  if (previous.key === key && now - previous.at < cooldownMs) {
    return { emit: false, next: previous };
  }
  return {
    emit: true,
    next: {
      key,
      at: now,
    },
  };
}
