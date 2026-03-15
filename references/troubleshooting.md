# Troubleshooting

## Bridge won't start

**Symptoms**: `/claude-to-im start` fails or daemon exits immediately.

**Steps**:

1. Run `/claude-to-im doctor` to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that Claude Code CLI is available: `claude --version`
4. Verify config exists: `ls -la ~/.claude-to-im/config.env`
5. Check logs for startup errors: `/claude-to-im logs`

**Common causes**:
- Missing or invalid config.env -- run `/claude-to-im setup`
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another instance is running with `/claude-to-im status`

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the bot token is valid: `/claude-to-im doctor`
2. Check allowed user IDs in config -- if set, only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited to the server with message read permissions
5. For Feishu: confirm the app has been approved and event subscriptions are configured
6. Check logs for incoming message events: `/claude-to-im logs 200`

## Permission timeout

**Symptoms**: Claude Code session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs Claude Code in non-interactive mode; ensure your Claude Code configuration allows the necessary tools
2. Consider using `--allowedTools` in your configuration to pre-approve common tools
3. Check network connectivity if the timeout occurs during API calls

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current memory usage: `/claude-to-im status`
2. Restart the daemon to reset memory:
   ```
   /claude-to-im stop
   /claude-to-im start
   ```
3. If the issue persists, check how many concurrent sessions are active -- each Claude Code session consumes memory
4. Review logs for error loops that may cause memory leaks

## "Claude Code native binary not found" but binary exists

**Symptoms**: Sending a message to the bot returns "Claude Code native binary not found at /path/to/claude", but the binary exists and is executable. `doctor` preflight check passes. The error only happens when a user sends a message.

**Root cause**: This is almost always a **bad `cwd`**, not a missing binary. The SDK catches `ENOENT` from `spawn()` and misreports it as "native binary not found". But `spawn()` throws `ENOENT` for both "command not found" AND "cwd directory does not exist".

**Common trigger**: `config.env` contains shell variables like `$HOME`, `$CWD`, or `~` in `CTI_DEFAULT_WORKDIR`. The config parser does NOT expand shell variables — the literal string `$HOME` gets stored in session bindings. When the daemon processes a message, it passes `cwd="$HOME"` (literal) to `spawn()`, which fails with ENOENT.

**Steps**:

1. Check `config.env` for unexpanded shell variables:
   ```bash
   grep -E '\$HOME|\$CWD|\$PWD|~/' ~/.claude-to-im/config.env
   ```
2. **Critical**: Also check persisted session data — even if config.env is fixed, old bindings may still have the bad value:
   ```bash
   grep -r '\$HOME\|"\$CWD"' ~/.claude-to-im/data/
   ```
3. Fix any literal `$HOME` / `$CWD` / `~` to absolute paths in:
   - `~/.claude-to-im/config.env`
   - `~/.claude-to-im/data/bindings.json`
   - `~/.claude-to-im/data/sessions.json`
4. Restart the daemon:
   ```bash
   /claude-to-im stop
   /claude-to-im start
   ```

**Why fixing config.env alone is not enough**: The bridge creates session bindings on first message. The binding stores `workingDirectory` from the config at creation time. Subsequent messages use the binding's stored value, not the current config default. So you must fix both the config AND the persisted binding data.

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Run `/claude-to-im stop` -- it will clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.claude-to-im/runtime/bridge.pid
   ```
3. Run `/claude-to-im start` to launch a fresh instance
