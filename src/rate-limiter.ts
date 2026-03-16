/**
 * Sliding-window per-user rate limiter.
 *
 * Tracks request timestamps per user key within a configurable window.
 * When CTI_RATE_LIMIT_RPM=0 (default) the limiter is a no-op.
 *
 * Usage:
 *   const limiter = new RateLimiter(rpm);
 *   const result = limiter.check(userId);
 *   if (!result.allowed) { ... return error ... }
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests allowed in the current window. */
  remaining: number;
  /** Seconds until the oldest request falls out of the window. */
  retryAfterSecs: number;
}

export class RateLimiter {
  /** requests per minute; 0 = unlimited */
  private readonly rpm: number;
  private readonly windowMs: number = 60_000;
  /** userId → sorted list of request timestamps (ms) */
  private readonly windows = new Map<string, number[]>();
  /** Periodic cleanup timer (avoids unbounded memory for inactive users). */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(rpm: number) {
    this.rpm = rpm;
    if (rpm > 0) {
      // Clean up stale entries every 5 minutes
      this.cleanupTimer = setInterval(() => this.evictStale(), 5 * 60_000);
      // Don't keep the process alive just for cleanup
      this.cleanupTimer.unref?.();
    }
  }

  /**
   * Check and record a new request for the given user key.
   * Returns { allowed: true } when within limits, { allowed: false } otherwise.
   */
  check(userId: string): RateLimitResult {
    if (this.rpm === 0) {
      return { allowed: true, remaining: Infinity, retryAfterSecs: 0 };
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(userId) ?? [];
    // Slide the window: drop entries older than windowMs
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= this.rpm) {
      // Window is full — compute when the oldest entry will expire
      const oldest = timestamps[0]!;
      const retryAfterSecs = Math.ceil((oldest + this.windowMs - now) / 1000);
      this.windows.set(userId, timestamps);
      return { allowed: false, remaining: 0, retryAfterSecs };
    }

    timestamps.push(now);
    this.windows.set(userId, timestamps);
    return {
      allowed: true,
      remaining: this.rpm - timestamps.length,
      retryAfterSecs: 0,
    };
  }

  /** Remove entries for users who have had no activity in the last window. */
  private evictStale(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [userId, timestamps] of this.windows) {
      if (timestamps.every((t) => t <= cutoff)) {
        this.windows.delete(userId);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}
