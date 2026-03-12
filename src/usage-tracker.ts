/**
 * Usage Tracker — accumulates per-session token usage and cost.
 *
 * Persists to ~/.claude-to-im/data/usage.json with debounced writes.
 * Provides a summary for the /claude-to-im stats command.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

interface SessionUsage {
  sessionId: string;
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  firstRequestAt: string;
  lastRequestAt: string;
}

interface UsageData {
  sessions: Record<string, SessionUsage>;
  globalTotals: {
    requestCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
  };
}

function readUsage(): UsageData {
  try {
    const raw = fs.readFileSync(USAGE_FILE, 'utf-8');
    return JSON.parse(raw) as UsageData;
  } catch {
    return {
      sessions: {},
      globalTotals: {
        requestCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
      },
    };
  }
}

function writeUsage(data: UsageData): void {
  const tmp = USAGE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, USAGE_FILE);
}

export class UsageTracker {
  private data: UsageData;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.data = readUsage();
  }

  /** Record usage from a completed request. */
  record(sessionId: string, usage: TokenUsage): void {
    const now = new Date().toISOString();
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const costUsd = usage.cost_usd || 0;

    // Update session totals
    let session = this.data.sessions[sessionId];
    if (!session) {
      session = {
        sessionId,
        requestCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCostUsd: 0,
        firstRequestAt: now,
        lastRequestAt: now,
      };
      this.data.sessions[sessionId] = session;
    }
    session.requestCount++;
    session.totalInputTokens += inputTokens;
    session.totalOutputTokens += outputTokens;
    session.totalCacheReadTokens += cacheRead;
    session.totalCostUsd += costUsd;
    session.lastRequestAt = now;

    // Update global totals
    this.data.globalTotals.requestCount++;
    this.data.globalTotals.totalInputTokens += inputTokens;
    this.data.globalTotals.totalOutputTokens += outputTokens;
    this.data.globalTotals.totalCostUsd += costUsd;

    this.schedulePersist();
  }

  /** Get a formatted summary string. */
  summary(): string {
    const g = this.data.globalTotals;
    const sessionCount = Object.keys(this.data.sessions).length;
    const lines = [
      `Total requests: ${g.requestCount}`,
      `Total sessions: ${sessionCount}`,
      `Input tokens:   ${g.totalInputTokens.toLocaleString()}`,
      `Output tokens:  ${g.totalOutputTokens.toLocaleString()}`,
      `Total cost:     $${g.totalCostUsd.toFixed(4)}`,
    ];

    // Top 5 sessions by usage
    const sorted = Object.values(this.data.sessions)
      .sort((a, b) => (b.totalInputTokens + b.totalOutputTokens) - (a.totalInputTokens + a.totalOutputTokens))
      .slice(0, 5);

    if (sorted.length > 0) {
      lines.push('', 'Top sessions:');
      for (const s of sorted) {
        const total = s.totalInputTokens + s.totalOutputTokens;
        lines.push(`  ${s.sessionId.slice(0, 8)}... ${s.requestCount} reqs, ${total.toLocaleString()} tokens, $${s.totalCostUsd.toFixed(4)}`);
      }
    }

    return lines.join('\n');
  }

  /** Get raw data for programmatic access. */
  getData(): UsageData {
    return this.data;
  }

  private schedulePersist(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      writeUsage(this.data);
    }, 500);
    this.writeTimer.unref?.();
  }

  /** Flush pending writes immediately. */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    writeUsage(this.data);
  }
}
