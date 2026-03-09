import fs from 'node:fs';

import { CONFIG_PATH, loadConfig, configToSettings } from '../src/config.js';
import {
  enqueueMobileConnectCommand,
  isBridgeRunning,
  listMobileCandidates,
  waitForMobileCommandResult,
} from '../src/mobile-control.js';
import { resolveCurrentRuntimeSession } from '../src/mobile-session.js';
import { JsonFileStore } from '../src/store.js';

interface CliArgs {
  command: 'list' | 'connect';
  selector?: string;
  json: boolean;
  force: boolean;
}

function usage(): never {
  console.error('Usage: mobile.ts list [--json] | connect <index|channel:chatId> [--force] [--json]');
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const [command, maybeSelector, ...rest] = argv;
  if (command !== 'list' && command !== 'connect') usage();

  const json = [maybeSelector, ...rest].includes('--json');
  const force = [maybeSelector, ...rest].includes('--force') || [maybeSelector, ...rest].includes('force');

  if (command === 'connect') {
    const selector = maybeSelector && !maybeSelector.startsWith('--') && maybeSelector !== 'force'
      ? maybeSelector
      : undefined;
    if (!selector) usage();
    return { command, selector, json, force };
  }

  return { command, json, force: false };
}

function printJson(payload: unknown): never {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

function printError(message: string, extra?: Record<string, unknown>): never {
  const payload = { ok: false, message, ...extra };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

function shortSession(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function printCandidates(candidates: ReturnType<typeof listMobileCandidates>): void {
  if (candidates.length === 0) {
    console.log('No previously connected chats found. Send a message from the target IM chat first, then run /claude-to-im mobile again.');
    return;
  }

  console.log('Available chats:');
  for (const candidate of candidates) {
    const current = candidate.connectedToCurrentRuntime ? ' [current]' : '';
    const active = candidate.active ? 'active' : 'inactive';
    console.log(
      `${candidate.index}. ${candidate.ref}${current} — session ${shortSession(candidate.codepilotSessionId)}... — ${active} — ${candidate.workingDirectory || '~'}`,
    );
  }
}

function resolveSelector(
  selector: string,
  candidates: ReturnType<typeof listMobileCandidates>,
): (typeof candidates)[number] | null {
  if (/^\d+$/.test(selector)) {
    const index = Number(selector);
    return candidates.find((candidate) => candidate.index === index) ?? null;
  }
  return candidates.find((candidate) => candidate.ref === selector) ?? null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(CONFIG_PATH)) {
    printError('No configuration found. Run /claude-to-im setup first.');
  }

  const config = loadConfig();
  const store = new JsonFileStore(configToSettings(config));
  const runtimeSession = resolveCurrentRuntimeSession(process.env, process.cwd());

  if ('message' in runtimeSession) {
    printError(runtimeSession.message, {
      runtimeHint: runtimeSession.runtimeHint,
      searchedEnvVars: runtimeSession.searchedEnvVars,
    });
  }

  const candidates = listMobileCandidates(store, runtimeSession.runtimeSessionKey);

  if (args.command === 'list') {
    if (args.json) {
      printJson({
        ok: true,
        currentRuntimeSession: runtimeSession,
        candidates,
      });
    }
    printCandidates(candidates);
    return;
  }

  if (!isBridgeRunning()) {
    printError('Bridge is not running. Start it first with /claude-to-im start.');
  }

  const selected = resolveSelector(args.selector!, candidates);
  if (!selected) {
    printError(`Target not found: ${args.selector}`, {
      availableRefs: candidates.map((candidate) => candidate.ref),
    });
  }

  const commandId = enqueueMobileConnectCommand({
    runtime: runtimeSession.runtime,
    runtimeSessionKey: runtimeSession.runtimeSessionKey,
    nativeSessionId: runtimeSession.nativeSessionId,
    workingDirectory: runtimeSession.workingDirectory,
    model: runtimeSession.model,
    target: {
      channelType: selected.channelType,
      chatId: selected.chatId,
    },
    force: args.force,
    sendConfirmation: true,
  });

  const result = await waitForMobileCommandResult(commandId);
  if (!result) {
    printError('Timed out waiting for bridge response. Make sure the daemon is running and try again.');
  }

  if (args.json) {
    printJson({
      ok: result.status === 'connected' || result.status === 'already_connected',
      result,
    });
  }

  switch (result.status) {
    case 'connected':
    case 'already_connected':
      console.log(result.message);
      if (result.confirmation?.sent) {
        console.log('Confirmation message sent to target chat.');
      } else if (result.confirmation?.skipped) {
        console.log(`Confirmation skipped: ${result.confirmation.error || 'unsupported on this channel'}`);
      } else if (result.confirmation?.error) {
        console.log(`Binding succeeded, but confirmation failed: ${result.confirmation.error}`);
      }
      return;
    case 'requires_confirmation':
      console.log(result.message);
      if (result.existingBinding) {
        console.log(
          `Existing binding: session ${shortSession(result.existingBinding.codepilotSessionId)}... — ${result.existingBinding.workingDirectory || '~'}`,
        );
      }
      console.log(`Re-run with force: /claude-to-im mobile ${selected.ref} --force`);
      process.exit(2);
    case 'error':
    default:
      printError(result.message, { result });
  }
}

void main().catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
});
