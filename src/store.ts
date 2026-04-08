/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.claude-to-im/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { ChannelBinding, ChannelType } from 'claude-to-im/src/lib/bridge/types.js';
import { CTI_HOME } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const STATE_DIR = path.join(DATA_DIR, 'session-states');

// ── CLI Session Interface ──

/**
 * CLI Session metadata from ~/.claude/sessions/{pid}.json
 * These are sessions started directly from the terminal with `claude` command.
 */
export interface CliSession {
  sessionId: string;      // SDK session ID (used for --resume)
  pid: number;            // Process ID
  cwd: string;            // Working directory
  startedAt: number;      // Start timestamp (ms since epoch)
  kind: string;           // Session kind (e.g., "interactive")
  entrypoint: string;     // Entry point (e.g., "cli")
  name: string;           // Session name/alias (e.g., "enhance-session-management")
  isActive: boolean;      // Whether the process is still running
}

// ── Session State Interface ──

/**
 * Session state for bridge synchronization.
 * Stored in ~/.claude-to-im/data/session-states/{sdkSessionId}.json
 */
export interface SessionState {
  sessionId: string;              // SDK session ID
  cliPid?: number;                // CLI process ID (from hook)
  cliTty?: string;                // CLI TTY path (from hook)
  cliStartedAt?: string;          // CLI start time
  cliEndedAt?: string;            // CLI end time
  cliResumedAt?: string;          // Last CLI resume time
  lastCliActivityAt?: string;     // Last CLI activity

  lastTakenOverAt?: string;       // Last taken over by bridge
  lastBridgeMessageAt?: string;   // Last bridge message time
  lastBridgeSummary?: string;     // Last bridge message summary
  takenOverBy?: {
    channelType: string;
    chatId: string;
    userName?: string;
  };
}

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    // Access sdkSessionId from data (may not be in the type definition)
    const dataWithSdk = data as unknown as { sdkSessionId?: string };

    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        codepilotSessionId: data.codepilotSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        // Use provided sdkSessionId if available, otherwise keep existing
        sdkSessionId: dataWithSdk.sdkSessionId ?? existing.sdkSessionId,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }
    const binding: ChannelBinding = {
      id: uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      // Use provided sdkSessionId if available
      sdkSessionId: dataWithSdk.sdkSessionId || '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (this.settings.get('bridge_default_mode') as 'code' | 'plan' | 'ask') || 'code',
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        this.bindings.set(key, { ...b, ...updates, updatedAt: now() });
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── CLI Session Support ──

  /**
   * Check if a process is still running.
   * Uses kill(pid, 0) which doesn't actually send a signal but checks existence.
   */
  private isProcessActive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all CLI sessions from ~/.claude/sessions/*.json
   * These are sessions started directly from the terminal with `claude` command.
   */
  listCliSessions(): CliSession[] {
    const home = process.env.HOME || '';
    const sessionsDir = path.join(home, '.claude', 'sessions');
    const sessions: CliSession[] = [];

    try {
      const files = fs.readdirSync(sessionsDir);
      for (const file of files) {
        // Only process {pid}.json files
        if (!file.endsWith('.json')) continue;
        const pidStr = file.slice(0, -5);
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) continue;

        try {
          const filePath = path.join(sessionsDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const data = JSON.parse(content);

          // Check if process is still active
          const isActive = this.isProcessActive(pid);

          sessions.push({
            sessionId: data.sessionId,
            pid,
            cwd: data.cwd,
            startedAt: data.startedAt,
            kind: data.kind || 'interactive',
            entrypoint: data.entrypoint || 'cli',
            name: data.name || '',
            isActive,
          });
        } catch {
          // Skip files that can't be parsed
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
      return [];
    }

    // Sort by startedAt descending (newest first)
    return sessions.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Get a specific CLI session by sessionId.
   * Supports both full ID and prefix matching.
   */
  getCliSession(sessionId: string): CliSession | null {
    const sessions = this.listCliSessions();
    return sessions.find(s =>
      s.sessionId === sessionId || s.sessionId.startsWith(sessionId)
    ) || null;
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session: BridgeSession = {
      id: uuid(),
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      this.persistSessions();
    }
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content });
    this.persistMessages(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // no-op for file-based store
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      // Store sdkSessionId on the session object
      (s as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }

  // ── Session State Management (for Bridge-CLI synchronization) ──

  /**
   * Get the state file path for a session.
   * State files are stored in ~/.claude-to-im/data/session-states/{sdkSessionId}.json
   */
  private getSessionStatePath(sdkSessionId: string): string {
    ensureDir(STATE_DIR);
    return path.join(STATE_DIR, `${sdkSessionId}.json`);
  }

  /**
   * Read session state from file.
   * Returns null if the file doesn't exist or can't be read.
   */
  getSessionState(sdkSessionId: string): SessionState | null {
    return readJson<SessionState | null>(
      this.getSessionStatePath(sdkSessionId),
      null,
    );
  }

  /**
   * Write session state to file.
   */
  private writeSessionState(sdkSessionId: string, state: SessionState): void {
    writeJson(this.getSessionStatePath(sdkSessionId), state);
  }

  /**
   * Mark a session as taken over by the bridge.
   * Called when /bind is used to take over a CLI session.
   */
  markSessionTakenOver(
    sdkSessionId: string,
    channelType: string,
    chatId: string,
    userName?: string,
  ): void {
    if (!sdkSessionId) return;

    const state = this.getSessionState(sdkSessionId) || { sessionId: sdkSessionId };

    state.lastTakenOverAt = now();
    state.takenOverBy = {
      channelType,
      chatId,
      userName,
    };

    this.writeSessionState(sdkSessionId, state);

    // Also try to send a real-time notification to the CLI TTY
    if (state.cliTty) {
      const message = [
        '',
        '='.repeat(60),
        '⚠️  此 Session 已在飞书上被接管',
        '='.repeat(60),
        `接管时间: ${new Date().toLocaleString('zh-CN')}`,
        '如果继续在此终端操作，可能会与飞书侧产生冲突。',
        '建议关闭此终端或使用 claude --resume 重新开始。',
        '='.repeat(60),
        '',
      ].join('\n');
      this.writeToTty(state.cliTty, message);
    }
  }

  /**
   * Record bridge activity (message sent/received).
   * Called after handling a message from the IM channel.
   */
  recordBridgeActivity(sdkSessionId: string, summary: string): void {
    if (!sdkSessionId) return;

    const state = this.getSessionState(sdkSessionId);
    if (!state) return;

    state.lastBridgeMessageAt = now();
    state.lastBridgeSummary = summary.slice(0, 500);  // Limit size

    this.writeSessionState(sdkSessionId, state);

    // Also send a real-time notification to the CLI TTY if available
    if (state.cliTty) {
      const shortSummary = summary.length > 100 ? summary.slice(0, 100) + '...' : summary;
      const message = `\n📩 [飞书] ${new Date().toLocaleTimeString('zh-CN')}: ${shortSummary}\n`;
      this.writeToTty(state.cliTty, message);
    }
  }

  // ── TTY Notification (Real-time Echo) ──

  /**
   * Write a message directly to a TTY device.
   * This allows real-time notification to CLI sessions.
   */
  writeToTty(tty: string, message: string): boolean {
    if (!tty || !fs.existsSync(tty)) {
      return false;
    }

    try {
      fs.writeFileSync(tty, message + '\n', 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a notification to a CLI session via TTY.
   * Looks up the TTY from session state.
   */
  notifyCliSession(sdkSessionId: string, message: string): boolean {
    const state = this.getSessionState(sdkSessionId);
    if (!state || !state.cliTty) {
      return false;
    }
    return this.writeToTty(state.cliTty, message);
  }

  // ── CLI Session Process Management ──

  /**
   * Terminate a CLI session process.
   * Uses SIGTERM first, then SIGKILL if process doesn't exit.
   * Returns true if the process was terminated successfully.
   */
  terminateCliSession(sdkSessionId: string): { success: boolean; reason: string } {
    const state = this.getSessionState(sdkSessionId);
    if (!state || !state.cliPid) {
      return { success: false, reason: 'No process information found' };
    }

    const pid = state.cliPid;

    try {
      // Check if process is still running
      if (!this.isProcessActive(pid)) {
        return { success: true, reason: 'Process already exited' };
      }

      // Try SIGTERM first (graceful termination)
      process.kill(pid, 'SIGTERM');

      // Wait a bit and check if it exited
      let attempts = 0;
      const maxAttempts = 5;
      while (attempts < maxAttempts && this.isProcessActive(pid)) {
        // Sleep for 200ms
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        attempts++;
      }

      if (this.isProcessActive(pid)) {
        // Process didn't exit gracefully, try SIGKILL
        try {
          process.kill(pid, 'SIGKILL');
          return { success: true, reason: 'Process terminated with SIGKILL (after SIGTERM timeout)' };
        } catch {
          return { success: false, reason: 'Failed to terminate process with SIGKILL' };
        }
      }

      return { success: true, reason: 'Process terminated gracefully with SIGTERM' };
    } catch (error) {
      const err = error as Error;
      return { success: false, reason: `Error: ${err.message}` };
    }
  }

  /**
   * Get CLI session info including TTY and process info from state file.
   * Combines information from both ~/.claude/sessions/ and state file.
   */
  getCliSessionWithState(sessionId: string): (CliSession & { state?: SessionState }) | null {
    const cliSession = this.getCliSession(sessionId);
    if (!cliSession) return null;

    const state = this.getSessionState(cliSession.sessionId);
    return { ...cliSession, state };
  }
}
