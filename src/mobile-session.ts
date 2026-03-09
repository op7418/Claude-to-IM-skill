export interface CurrentRuntimeSession {
  runtime: 'codex' | 'claude';
  runtimeSessionKey: string;
  nativeSessionId: string;
  sourceEnv: string;
  workingDirectory: string;
  model: string;
}

export interface CurrentRuntimeSessionError {
  runtimeHint: 'codex' | 'claude' | 'unknown';
  message: string;
  searchedEnvVars: string[];
}

const CLAUDE_SESSION_ENV_KEYS = [
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CONVERSATION_ID',
  'CLAUDE_THREAD_ID',
  'ANTHROPIC_SESSION_ID',
] as const;

function firstEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env[key];
    if (value && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

function resolveRuntimeHint(env: NodeJS.ProcessEnv): 'codex' | 'claude' | 'unknown' {
  if (env.CODEX_THREAD_ID || env.CODEX_CI || env.CODEX_MANAGED_BY_NPM) {
    return 'codex';
  }
  if (
    env.CLAUDECODE
    || env.CLAUDE_CODE_ENTRYPOINT
    || env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
    || env.ANTHROPIC_AUTH_TOKEN
  ) {
    return 'claude';
  }
  return 'unknown';
}

export function resolveCurrentRuntimeSession(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): CurrentRuntimeSession | CurrentRuntimeSessionError {
  const codex = firstEnv(env, ['CODEX_THREAD_ID']);
  if (codex) {
    return {
      runtime: 'codex',
      runtimeSessionKey: `codex:${codex.value}`,
      nativeSessionId: codex.value,
      sourceEnv: codex.key,
      workingDirectory,
      model: env.CODEX_MODEL || env.OPENAI_MODEL || '',
    };
  }

  const claude = firstEnv(env, CLAUDE_SESSION_ENV_KEYS);
  if (claude) {
    return {
      runtime: 'claude',
      runtimeSessionKey: `claude:${claude.value}`,
      nativeSessionId: claude.value,
      sourceEnv: claude.key,
      workingDirectory,
      model: env.CLAUDE_MODEL || env.ANTHROPIC_MODEL || '',
    };
  }

  const runtimeHint = resolveRuntimeHint(env);
  return {
    runtimeHint,
    searchedEnvVars: ['CODEX_THREAD_ID', ...CLAUDE_SESSION_ENV_KEYS],
    message:
      runtimeHint === 'claude'
        ? 'Current Claude Code session ID is not exposed in the environment, so mobile handoff cannot safely bind this live session.'
        : 'Current session ID is not available in the environment, so mobile handoff cannot determine which live session to resume.',
  };
}
