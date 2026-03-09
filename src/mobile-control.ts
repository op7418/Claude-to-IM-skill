import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { BaseChannelAdapter } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { deliver } from 'claude-to-im/src/lib/bridge/delivery-layer.js';
import { CTI_HOME } from './config.js';
import type {
  JsonFileStore,
  RuntimeSessionBinding,
} from './store.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const MOBILE_ROOT = path.join(RUNTIME_DIR, 'mobile-commands');
const MOBILE_PENDING_DIR = path.join(MOBILE_ROOT, 'pending');
const MOBILE_RESULTS_DIR = path.join(MOBILE_ROOT, 'results');
const MOBILE_COMMAND_TIMEOUT_MS = 15_000;
const MOBILE_CONFIRMATION_SKIP_CHANNELS = new Set(['qq']);
const BRIDGE_MANAGER_GLOBAL_KEY = '__bridge_manager__';

export interface MobileCandidate {
  index: number;
  ref: string;
  channelType: string;
  chatId: string;
  codepilotSessionId: string;
  active: boolean;
  workingDirectory: string;
  model: string;
  updatedAt: string;
  connectedToCurrentRuntime: boolean;
}

export interface MobileConnectCommand {
  id: string;
  type: 'connect';
  createdAt: string;
  runtime: 'codex' | 'claude';
  runtimeSessionKey: string;
  nativeSessionId: string;
  workingDirectory: string;
  model: string;
  target: {
    channelType: string;
    chatId: string;
  };
  force: boolean;
  sendConfirmation: boolean;
}

export interface MobileConnectResult {
  id: string;
  status: 'connected' | 'already_connected' | 'requires_confirmation' | 'error';
  message: string;
  target: {
    ref: string;
    channelType: string;
    chatId: string;
  };
  session?: {
    codepilotSessionId: string;
    runtimeSessionKey: string;
    nativeSessionId: string;
  };
  existingBinding?: {
    codepilotSessionId: string;
    workingDirectory: string;
    model: string;
    updatedAt: string;
  };
  confirmation?: {
    sent: boolean;
    skipped?: boolean;
    error?: string;
  };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function now(): string {
  return new Date().toISOString();
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function shortSession(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function getLiveAdapter(channelType: string): BaseChannelAdapter | null {
  const state = (globalThis as Record<string, unknown>)[BRIDGE_MANAGER_GLOBAL_KEY] as
    | { adapters?: Map<string, BaseChannelAdapter> }
    | undefined;
  return state?.adapters?.get(channelType) ?? null;
}

function buildTargetRef(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

function ensureMobileCommandDirs(): void {
  ensureDir(MOBILE_PENDING_DIR);
  ensureDir(MOBILE_RESULTS_DIR);
}

function makeMobileConfirmationText(sessionId: string): string {
  return [
    'Connected to your current Claude/Codex session.',
    `Session: ${shortSession(sessionId)}...`,
    'Continue chatting here to keep using the same session context.',
  ].join('\n');
}

function ensureRuntimeLinkedSession(
  store: JsonFileStore,
  command: MobileConnectCommand,
): RuntimeSessionBinding {
  const existing = store.getRuntimeSessionBinding(command.runtimeSessionKey);
  const session = existing ? store.getSession(existing.codepilotSessionId) : null;

  if (existing && session) {
    return store.upsertRuntimeSessionBinding({
      runtimeSessionKey: command.runtimeSessionKey,
      runtime: command.runtime,
      nativeSessionId: command.nativeSessionId,
      codepilotSessionId: existing.codepilotSessionId,
      workingDirectory: command.workingDirectory,
      model: command.model,
    });
  }

  const created = store.createSession(
    `Mobile: ${command.runtime} ${shortSession(command.nativeSessionId)}`,
    command.model || store.getSetting('bridge_default_model') || '',
    undefined,
    command.workingDirectory || store.getSetting('bridge_default_work_dir') || process.cwd(),
    store.getSetting('bridge_default_mode') || 'code',
  );

  if (command.nativeSessionId) {
    store.updateSdkSessionId(created.id, command.nativeSessionId);
  }

  return store.upsertRuntimeSessionBinding({
    runtimeSessionKey: command.runtimeSessionKey,
    runtime: command.runtime,
    nativeSessionId: command.nativeSessionId,
    codepilotSessionId: created.id,
    workingDirectory: command.workingDirectory,
    model: command.model,
  });
}

async function maybeSendConfirmation(
  channelType: string,
  chatId: string,
  sessionId: string,
): Promise<NonNullable<MobileConnectResult['confirmation']>> {
  if (MOBILE_CONFIRMATION_SKIP_CHANNELS.has(channelType)) {
    return {
      sent: false,
      skipped: true,
      error: `${channelType} does not support proactive confirmation messages.`,
    };
  }

  const adapter = getLiveAdapter(channelType);
  if (!adapter || !adapter.isRunning()) {
    return {
      sent: false,
      error: `Adapter ${channelType} is not running.`,
    };
  }

  const result = await deliver(adapter, {
    address: {
      channelType,
      chatId,
    },
    text: makeMobileConfirmationText(sessionId),
    parseMode: 'plain',
  });

  if (result.ok) {
    return { sent: true };
  }

  return {
    sent: false,
    error: result.error || 'Failed to send confirmation message.',
  };
}

async function processConnectCommand(
  store: JsonFileStore,
  command: MobileConnectCommand,
): Promise<MobileConnectResult> {
  const runtimeBinding = ensureRuntimeLinkedSession(store, command);
  const existing = store.getChannelBinding(command.target.channelType, command.target.chatId);
  const targetRef = buildTargetRef(command.target.channelType, command.target.chatId);

  if (existing && existing.codepilotSessionId === runtimeBinding.codepilotSessionId) {
    if (command.nativeSessionId) {
      store.updateSdkSessionId(runtimeBinding.codepilotSessionId, command.nativeSessionId);
    }
    return {
      id: command.id,
      status: 'already_connected',
      message: `${targetRef} is already connected to the current session.`,
      target: {
        ref: targetRef,
        channelType: command.target.channelType,
        chatId: command.target.chatId,
      },
      session: {
        codepilotSessionId: runtimeBinding.codepilotSessionId,
        runtimeSessionKey: runtimeBinding.runtimeSessionKey,
        nativeSessionId: runtimeBinding.nativeSessionId,
      },
    };
  }

  if (existing && existing.codepilotSessionId !== runtimeBinding.codepilotSessionId && !command.force) {
    return {
      id: command.id,
      status: 'requires_confirmation',
      message: `${targetRef} is already bound to another session. Re-run with force to overwrite.`,
      target: {
        ref: targetRef,
        channelType: command.target.channelType,
        chatId: command.target.chatId,
      },
      session: {
        codepilotSessionId: runtimeBinding.codepilotSessionId,
        runtimeSessionKey: runtimeBinding.runtimeSessionKey,
        nativeSessionId: runtimeBinding.nativeSessionId,
      },
      existingBinding: {
        codepilotSessionId: existing.codepilotSessionId,
        workingDirectory: existing.workingDirectory,
        model: existing.model,
        updatedAt: existing.updatedAt,
      },
    };
  }

  const binding = store.upsertChannelBinding({
    channelType: command.target.channelType,
    chatId: command.target.chatId,
    codepilotSessionId: runtimeBinding.codepilotSessionId,
    workingDirectory: command.workingDirectory || runtimeBinding.workingDirectory,
    model: command.model || runtimeBinding.model,
  });

  if (command.nativeSessionId) {
    store.updateSdkSessionId(runtimeBinding.codepilotSessionId, command.nativeSessionId);
  }
  if (command.model) {
    store.updateSessionModel(runtimeBinding.codepilotSessionId, command.model);
  }

  const confirmation = command.sendConfirmation
    ? await maybeSendConfirmation(binding.channelType, binding.chatId, binding.codepilotSessionId)
    : { sent: false, skipped: true };

  return {
    id: command.id,
    status: 'connected',
    message: `${targetRef} is now connected to the current session.`,
    target: {
      ref: targetRef,
      channelType: command.target.channelType,
      chatId: command.target.chatId,
    },
    session: {
      codepilotSessionId: runtimeBinding.codepilotSessionId,
      runtimeSessionKey: runtimeBinding.runtimeSessionKey,
      nativeSessionId: runtimeBinding.nativeSessionId,
    },
    confirmation,
  };
}

async function processMobileCommand(
  store: JsonFileStore,
  commandPath: string,
): Promise<void> {
  const command = readJson<MobileConnectCommand | null>(commandPath, null);
  if (!command) {
    fs.rmSync(commandPath, { force: true });
    return;
  }

  let result: MobileConnectResult;
  try {
    switch (command.type) {
      case 'connect':
        result = await processConnectCommand(store, command);
        break;
      default:
        result = {
          id: command.id,
          status: 'error',
          message: `Unknown mobile command type: ${(command as { type?: string }).type || 'unknown'}`,
          target: {
            ref: buildTargetRef(command.target.channelType, command.target.chatId),
            channelType: command.target.channelType,
            chatId: command.target.chatId,
          },
        };
        break;
    }
  } catch (err) {
    result = {
      id: command.id,
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
      target: {
        ref: buildTargetRef(command.target.channelType, command.target.chatId),
        channelType: command.target.channelType,
        chatId: command.target.chatId,
      },
    };
  }

  ensureMobileCommandDirs();
  atomicWriteJson(path.join(MOBILE_RESULTS_DIR, `${command.id}.json`), result);
  fs.rmSync(commandPath, { force: true });
}

export function listMobileCandidates(
  store: JsonFileStore,
  currentRuntimeSessionKey?: string,
): MobileCandidate[] {
  const currentRuntimeBinding = currentRuntimeSessionKey
    ? store.getRuntimeSessionBinding(currentRuntimeSessionKey)
    : null;

  return store
    .listChannelBindings()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((binding, index) => ({
      index: index + 1,
      ref: buildTargetRef(binding.channelType, binding.chatId),
      channelType: binding.channelType,
      chatId: binding.chatId,
      codepilotSessionId: binding.codepilotSessionId,
      active: binding.active,
      workingDirectory: binding.workingDirectory,
      model: binding.model,
      updatedAt: binding.updatedAt,
      connectedToCurrentRuntime: binding.codepilotSessionId === currentRuntimeBinding?.codepilotSessionId,
    }));
}

export function isBridgeRunning(): boolean {
  const status = readJson<{ running?: boolean }>(
    path.join(RUNTIME_DIR, 'status.json'),
    {},
  );
  return status.running === true;
}

export function enqueueMobileConnectCommand(
  command: Omit<MobileConnectCommand, 'id' | 'createdAt' | 'type'>,
): string {
  ensureMobileCommandDirs();
  const id = crypto.randomUUID();
  const record: MobileConnectCommand = {
    ...command,
    id,
    type: 'connect',
    createdAt: now(),
  };
  atomicWriteJson(path.join(MOBILE_PENDING_DIR, `${id}.json`), record);
  return id;
}

export async function waitForMobileCommandResult(
  commandId: string,
  timeoutMs = MOBILE_COMMAND_TIMEOUT_MS,
): Promise<MobileConnectResult | null> {
  ensureMobileCommandDirs();
  const resultPath = path.join(MOBILE_RESULTS_DIR, `${commandId}.json`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      const result = readJson<MobileConnectResult | null>(resultPath, null);
      fs.rmSync(resultPath, { force: true });
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

export function startMobileCommandProcessor(store: JsonFileStore): () => void {
  ensureMobileCommandDirs();

  let stopped = false;
  let running = false;

  const scan = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const entries = fs.readdirSync(MOBILE_PENDING_DIR)
        .filter((entry) => entry.endsWith('.json'))
        .sort();

      for (const entry of entries) {
        await processMobileCommand(store, path.join(MOBILE_PENDING_DIR, entry));
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void scan();
  }, 1000);
  timer.unref();
  void scan();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
