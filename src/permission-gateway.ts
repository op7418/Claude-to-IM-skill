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
  private timeoutMs = 5 * 60 * 1000; // 5 minutes

  waitFor(toolUseID: string): Promise<PermissionResult> {
    console.info(`[permission-gateway] waitFor: ${toolUseID.slice(0, 16)}... (pending size: ${this.pending.size})`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseID);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, this.timeoutMs);
      this.pending.set(toolUseID, { resolve, timer });
      console.info(`[permission-gateway] waitFor set: ${toolUseID.slice(0, 16)}... (pending size now: ${this.pending.size})`);
    });
  }

  resolve(permissionRequestId: string, resolution: PermissionResolution): boolean {
    console.info(`[permission-gateway] resolve called: ${permissionRequestId.slice(0, 16)}... pending keys: ${[...this.pending.keys()].map(k => k.slice(0, 16)).join(', ')}`);
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
