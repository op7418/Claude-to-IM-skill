export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
}

export interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;
}

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
    timer: NodeJS.Timeout;
  }>();
  // Default 5 minutes; override with CTI_PERMISSION_TIMEOUT_MS (milliseconds).
  private timeoutMs = parseInt(process.env['CTI_PERMISSION_TIMEOUT_MS'] ?? '300000', 10);

  waitFor(toolUseID: string): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseID);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, this.timeoutMs);
      this.pending.set(toolUseID, { resolve, timer });
    });
  }

  resolve(permissionRequestId: string, resolution: PermissionResolution): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
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
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
