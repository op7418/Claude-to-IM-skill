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

## Session looks stuck

**Symptoms**: One task starts, but later messages in the same chat get no useful reply or appear to hang forever.

**Steps**:

1. Send `/stop` in the same chat to interrupt the current session task
2. If you want a clean thread, send `/new`
3. Check whether the bridge is repeatedly waiting on one long Codex turn: `/claude-to-im logs 200`
4. Optionally set a turn timeout in `config.env`:
   ```bash
   CTI_CODEX_TURN_TIMEOUT_MS=1800000
   ```
5. Restart the bridge after config changes:
   ```bash
   /claude-to-im stop
   /claude-to-im start
   ```

**Notes**:

- Newer bridge builds return an explicit "task still running" message instead of silently queueing later chat messages.
- If the task is truly stuck, the bridge can auto-stop it after the idle window set by `CTI_ACTIVE_TASK_STALE_MS` (default 15 minutes).

## Permission timeout

**Symptoms**: Claude Code session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs Claude Code in non-interactive mode; ensure your Claude Code configuration allows the necessary tools
2. Consider using `--allowedTools` in your configuration to pre-approve common tools
3. Check network connectivity if the timeout occurs during API calls

For Feishu / QQ / WeChat, permission replies are text-based:

- Reply `1` to allow once
- Reply `2` to allow the session
- Reply `3` to deny
- Or use `/perm allow|allow_session|deny <id>`

If you want fully automatic approvals in a trusted environment, set:

```bash
CTI_AUTO_APPROVE=true
```

## Codex cannot SSH or use git

**Symptoms**: Codex from Feishu / WeChat can edit local files, but `ssh`, `git fetch/pull/push`, or git operations involving credentials keep failing.

**Steps**:

1. Enable Codex network access in `config.env`:
   ```bash
   CTI_CODEX_NETWORK_ENABLED=true
   ```
2. Give Codex the right sandbox level:
   ```bash
   CTI_CODEX_SANDBOX_MODE=workspace-write
   ```
   If your workflow depends on `~/.ssh`, `~/.gitconfig`, or other home-directory credentials, you may need:
   ```bash
   CTI_CODEX_SANDBOX_MODE=danger-full-access
   ```
3. If you want to keep `workspace-write`, explicitly grant the extra directories Codex needs:
   ```bash
   CTI_CODEX_ADDITIONAL_DIRECTORIES=$HOME/.ssh,$HOME/.config/git
   ```
4. Prefer SSH keys or a preconfigured git credential helper. Interactive password prompts are fragile in bridge-driven sessions.
5. Restart the bridge after config changes:
   ```bash
   /claude-to-im stop
   /claude-to-im start
   ```

**Notes**:

- `git add` / `git commit` may still trigger a permission request unless you approve it in chat or enable `CTI_AUTO_APPROVE=true`.
- Network-enabled Codex is a security tradeoff. Only use it in chats you control.

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

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Run `/claude-to-im stop` -- it will clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.claude-to-im/runtime/bridge.pid
   ```
3. Run `/claude-to-im start` to launch a fresh instance
