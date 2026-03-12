export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
}

export interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;
}

/** Callback invoked when a permission request is about to expire or has expired. */
export type PermissionNotifyFn = (toolUseID: string, event: 'warning' | 'timeout') => void;

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
    timer: NodeJS.Timeout;
    warningTimer?: NodeJS.Timeout;
  }>();
  // Default 5 minutes; override with CTI_PERMISSION_TIMEOUT_MS (milliseconds).
  private timeoutMs = parseInt(process.env['CTI_PERMISSION_TIMEOUT_MS'] ?? '300000', 10);
  // Warning 30 seconds before timeout
  private warningBeforeMs = 30_000;
  private notifyFn: PermissionNotifyFn | null = null;

  /** Register a callback for timeout warnings and expiry notifications. */
  onNotify(fn: PermissionNotifyFn): void {
    this.notifyFn = fn;
  }

  waitFor(toolUseID: string): Promise<PermissionResult> {
    return new Promise((resolve) => {
      // Set up warning timer (fires 30s before timeout)
      let warningTimer: NodeJS.Timeout | undefined;
      const warningDelay = this.timeoutMs - this.warningBeforeMs;
      if (warningDelay > 0 && this.notifyFn) {
        warningTimer = setTimeout(() => {
          this.notifyFn?.(toolUseID, 'warning');
        }, warningDelay);
        warningTimer.unref?.();
      }

      // Set up timeout timer
      const timer = setTimeout(() => {
        if (warningTimer) clearTimeout(warningTimer);
        this.pending.delete(toolUseID);
        this.notifyFn?.(toolUseID, 'timeout');
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, this.timeoutMs);

      this.pending.set(toolUseID, { resolve, timer, warningTimer });
    });
  }

  resolve(permissionRequestId: string, resolution: PermissionResolution): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    if (entry.warningTimer) clearTimeout(entry.warningTimer);
    if (resolution.behavior === 'allow') {
      entry.resolve({ behavior: 'allow' });
    } else {
      entry.resolve({ behavior: 'deny', message: resolution.message || 'Denied by user' });
    }
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      if (entry.warningTimer) clearTimeout(entry.warningTimer);
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
