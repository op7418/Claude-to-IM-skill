const PAUSE_DURATION_MS = 60 * 60 * 1000;

interface AccountPauseState {
  pausedAt: number;
  resumeAt: number;
  reason: string;
}

const pauseStates = new Map<string, AccountPauseState>();

export function isPaused(accountId: string): boolean {
  const state = pauseStates.get(accountId);
  if (!state) return false;
  if (Date.now() >= state.resumeAt) {
    pauseStates.delete(accountId);
    return false;
  }
  return true;
}

export function setPaused(accountId: string, reason: string = 'Session expired'): void {
  const pausedAt = Date.now();
  pauseStates.set(accountId, {
    pausedAt,
    resumeAt: pausedAt + PAUSE_DURATION_MS,
    reason,
  });
  console.log(`[weixin-session-guard] Account ${accountId} paused for 60 min: ${reason}`);
}

export function clearAllPauses(): void {
  pauseStates.clear();
}
