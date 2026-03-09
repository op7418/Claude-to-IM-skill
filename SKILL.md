---
name: claude-to-im
description: |
  Bridge THIS Claude Code session to Telegram, Discord, Feishu/Lark, WeCom, or QQ so the
  user can chat with Claude from their phone. Use for: setting up, starting, stopping,
  diagnosing the claude-to-im bridge daemon, or linking the current session to a mobile chat;
  forwarding Claude replies to a messaging
  app; any phrase like "claude-to-im", "bridge", "消息推送", "消息转发", "桥接",
  "连上飞书", "手机上看claude", "启动后台服务", "诊断", "查看日志", "配置", "mobile", "连接到手机".
  Subcommands: setup, mobile, start, stop, status, logs, reconfigure, doctor.
  Do NOT use for: building standalone bots, webhook integrations, or coding with IM
  platform SDKs — those are regular programming tasks.
argument-hint: "setup | mobile [selector] [--force] | start | stop | status | logs [N] | reconfigure | doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Claude-to-IM Bridge Skill

You are managing the Claude-to-IM bridge.
User data is stored at `~/.claude-to-im/`.

The skill directory (SKILL_DIR) is at `~/.claude/skills/claude-to-im`.
If that path doesn't exist, fall back to Glob with pattern `**/skills/**/claude-to-im/SKILL.md` and derive the root from the result.

## Command parsing

Parse the user's intent from `$ARGUMENTS` into one of these subcommands:

| User says (examples) | Subcommand |
|---|---|
| `setup`, `configure`, `配置`, `我想在飞书上用 Claude`, `帮我连接 Telegram` | setup |
| `mobile`, `连到手机`, `连接到 IM`, `把当前会话连到手机`, `open mobile chat` | mobile |
| `start`, `start bridge`, `启动`, `启动桥接` | start |
| `stop`, `stop bridge`, `停止`, `停止桥接` | stop |
| `status`, `bridge status`, `状态`, `运行状态`, `怎么看桥接的运行状态` | status |
| `logs`, `logs 200`, `查看日志`, `查看日志 200` | logs |
| `reconfigure`, `修改配置`, `帮我改一下 token`, `换个 bot` | reconfigure |
| `doctor`, `diagnose`, `诊断`, `挂了`, `没反应了`, `bot 没反应`, `出问题了` | doctor |

**Disambiguation: `status` vs `doctor`** — Use `status` when the user just wants to check if the bridge is running (informational). Use `doctor` when the user reports a problem or suspects something is broken (diagnostic). When in doubt and the user describes a symptom (e.g., "没反应了", "挂了"), prefer `doctor`.

Extract optional numeric argument for `logs` (default 50). For `mobile`, extract an optional selector (`1`, `2`, or `channelType:chatId`) and an optional overwrite flag (`--force` or `force`).

Before asking users for any platform credentials, first read `SKILL_DIR/references/setup-guides.md` to get the detailed step-by-step guidance for that platform. Present the relevant guide text to the user via AskUserQuestion — users often don't know where to find bot tokens or app secrets, so showing the guide upfront saves back-and-forth.

## Runtime detection

Before executing any subcommand, detect which environment you are running in:

1. **Claude Code** — `AskUserQuestion` tool is available. Use it for interactive setup wizards.
2. **Codex / other** — `AskUserQuestion` is NOT available. Fall back to non-interactive guidance: explain the steps, show `SKILL_DIR/config.env.example`, and ask the user to create `~/.claude-to-im/config.env` manually.

You can test this by checking if AskUserQuestion is in your available tools list.

## Config check (applies to `mobile`, `start`, `stop`, `status`, `logs`, `reconfigure`, `doctor`)

Before running any subcommand other than `setup`, check if `~/.claude-to-im/config.env` exists:

- **If it does NOT exist:**
  - In Claude Code: tell the user "No configuration found" and automatically start the `setup` wizard using AskUserQuestion.
  - In Codex: tell the user "No configuration found. Please create `~/.claude-to-im/config.env` based on the example:" then show the contents of `SKILL_DIR/config.env.example` and stop. Don't attempt to start the daemon — without config.env the process will crash on startup and leave behind a stale PID file that blocks future starts.
- **If it exists:** proceed with the requested subcommand.

## Subcommands

### `setup`

Run an interactive setup wizard. This subcommand requires `AskUserQuestion`. If it is not available (Codex environment), instead show the contents of `SKILL_DIR/config.env.example` with field-by-field explanations and instruct the user to create the config file manually.

When AskUserQuestion IS available, collect input **one field at a time**. After each answer, confirm the value back to the user (masking secrets to last 4 chars only) before moving to the next question.

**Step 1 — Choose channels**

Ask which channels to enable (telegram, discord, feishu, wecom, qq). Accept comma-separated input. Briefly describe each:
- **telegram** — Best for personal use. Streaming preview, inline permission buttons.
- **discord** — Good for team use. Server/channel/user-level access control.
- **feishu** (Lark) — For Feishu/Lark teams. Event-based messaging.
- **wecom** — Enterprise WeChat intelligent bot. Long-connection mode, text `/perm ...` approval, optional group allowlist.
- **qq** — QQ C2C private chat only. No inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands.

**Step 2 — Collect tokens per channel**

For each enabled channel, read `SKILL_DIR/references/setup-guides.md` and present the relevant platform guide to the user. Collect one credential at a time:

- **Telegram**: Bot Token → confirm (masked) → Chat ID (see guide for how to get it) → confirm → Allowed User IDs (optional). **Important:** At least one of Chat ID or Allowed User IDs must be set, otherwise the bot will reject all messages.
- **Discord**: Bot Token → confirm (masked) → Allowed User IDs → Allowed Channel IDs (optional) → Allowed Guild IDs (optional). **Important:** At least one of Allowed User IDs or Allowed Channel IDs must be set, otherwise the bot will reject all messages (default-deny).
- **Feishu**: App ID → confirm → App Secret → confirm (masked) → Domain (optional) → Allowed User IDs (optional). Guide through all 4 steps (A: batch permissions, B: enable bot, C: events & callbacks with long connection, D: publish version).
- **WeCom**: Collect the required bot fields, then optional access controls:
  1. WeCom Bot ID (required) → confirm
  2. WeCom Secret (required) → confirm (masked)
  3. Allowed User IDs (optional, press Enter to skip)
  4. Group Policy (optional, default `allowlist`) — `allowlist`, `open`, or `disabled`
  5. Allowed Group IDs (optional, used when Group Policy = `allowlist`)
  - Remind user: WeCom uses the intelligent bot long-connection mode and text `/perm ...` approval.
- **QQ**: Collect two required fields, then optional ones:
  1. QQ App ID (required) → confirm
  2. QQ App Secret (required) → confirm (masked)
  - Tell the user: these two values can be found at https://q.qq.com/qqbot/openclaw
  3. Allowed User OpenIDs (optional, press Enter to skip) — note: this is `user_openid`, NOT QQ number. If the user doesn't have openid yet, they can leave it empty.
  4. Image Enabled (optional, default true, press Enter to skip) — if the underlying provider doesn't support image input, set to false
  5. Max Image Size MB (optional, default 20, press Enter to skip)
  - Remind user: QQ first version only supports C2C private chat sandbox access. No group/channel support, no inline buttons, no streaming preview.

**Step 3 — General settings**

Ask for runtime, default working directory, model, and mode:
- **Runtime**: `claude` (default), `codex`, `auto`
  - `claude` — uses Claude Code CLI + Claude Agent SDK (requires `claude` CLI installed)
  - `codex` — uses OpenAI Codex SDK (requires `codex` CLI; auth via `codex auth login` or `OPENAI_API_KEY`)
  - `auto` — tries Claude first, falls back to Codex if Claude CLI not found
- **Working Directory**: default `$CWD`
- **Model** (optional): Leave blank to inherit the runtime's own default model. If the user wants to override, ask them to enter a model name. Do NOT hardcode or suggest specific model names — the available models change over time.
- **Mode**: `code` (default), `plan`, `ask`

**Step 4 — Write config and validate**

1. Show a final summary table with all settings (secrets masked to last 4 chars)
2. Ask user to confirm before writing
3. Use Bash to create directory structure: `mkdir -p ~/.claude-to-im/{data,logs,runtime,data/messages}`
4. Use Write to create `~/.claude-to-im/config.env` with all settings in KEY=VALUE format
5. Use Bash to set permissions: `chmod 600 ~/.claude-to-im/config.env`
6. Validate tokens — read `SKILL_DIR/references/token-validation.md` for the exact commands and expected responses for each platform. This catches typos and wrong credentials before the user tries to start the daemon.
7. Report results with a summary table. If any validation fails, explain what might be wrong and how to fix it.
8. On success, tell the user: "Setup complete! Run `/claude-to-im start` to start the bridge."

### `mobile`

Link the **current Claude Code / Codex session** to an existing IM chat so the user can continue in that mobile chat without starting a fresh bridge session.

**Pre-checks**
1. Verify `~/.claude-to-im/config.env` exists (see "Config check" above).
2. Ensure the bridge daemon is running. If not, run: `bash "$SKILL_DIR/scripts/daemon.sh" start`
3. Use the helper CLI for all list/connect operations:
   - List chats: `"$SKILL_DIR/node_modules/.bin/tsx" "$SKILL_DIR/scripts/mobile.ts" list --json`
   - Connect: `"$SKILL_DIR/node_modules/.bin/tsx" "$SKILL_DIR/scripts/mobile.ts" connect <selector> [--force] --json`

**Selection flow**
1. Run the `list --json` helper first.
2. If there are no candidates, tell the user to send a message from the target IM chat first, then rerun `/claude-to-im mobile`.
3. If the user did **not** provide a selector:
   - In Claude Code: use AskUserQuestion to let them choose from the numbered candidates.
   - In Codex: show the numbered list and ask them to rerun `/claude-to-im mobile <number>` or `/claude-to-im mobile <channelType:chatId>`.
4. If the user **did** provide a selector, run `connect`.

**Overwrite flow**
1. If `connect --json` returns `requires_confirmation`:
   - In Claude Code: ask whether to overwrite the existing binding, then rerun with `--force` if confirmed.
   - In Codex: show the exact rerun command with `--force`.
2. If it returns `connected` or `already_connected`, tell the user which chat is now linked and whether the confirmation message was sent to the IM side.

**Current-session requirement**
- This command only works when the runtime exposes a live session identifier (for example `CODEX_THREAD_ID` in Codex).
- If the helper reports that the current session ID is unavailable, explain that the runtime cannot safely hand off the live session yet.

### `start`

**Pre-check:** Verify `~/.claude-to-im/config.env` exists (see "Config check" above). Without it, the daemon will crash immediately and leave a stale PID file.

Run: `bash "$SKILL_DIR/scripts/daemon.sh" start`

Show the output to the user. If it fails, tell the user:
- Run `doctor` to diagnose: `/claude-to-im doctor`
- Check recent logs: `/claude-to-im logs`

### `stop`

Run: `bash "$SKILL_DIR/scripts/daemon.sh" stop`

### `status`

Run: `bash "$SKILL_DIR/scripts/daemon.sh" status`

### `logs`

Extract optional line count N from arguments (default 50).
Run: `bash "$SKILL_DIR/scripts/daemon.sh" logs N`

### `reconfigure`

1. Read current config from `~/.claude-to-im/config.env`
2. Show current settings in a clear table format, with all secrets masked (only last 4 chars visible)
3. Use AskUserQuestion to ask what the user wants to change
4. When collecting new values, read `SKILL_DIR/references/setup-guides.md` and present the relevant guide for that field
5. Update the config file atomically (write to tmp, rename)
6. Re-validate any changed tokens
7. Remind user: "Run `/claude-to-im stop` then `/claude-to-im start` to apply the changes."

### `doctor`

Run: `bash "$SKILL_DIR/scripts/doctor.sh"`

Show results and suggest fixes for any failures. Common fixes:
- SDK cli.js missing → `cd "$SKILL_DIR" && npm install`
- dist/daemon.mjs stale → `cd "$SKILL_DIR" && npm run build`
- Config missing → run `setup`

For more complex issues (messages not received, permission timeouts, high memory, stale PID files), read `SKILL_DIR/references/troubleshooting.md` for detailed diagnosis steps.

## Notes

- Always mask secrets in output (show only last 4 characters) — users often share terminal output in bug reports, so exposed tokens would be a security incident.
- Always check for config.env before starting the daemon — without it the process crashes on startup and leaves a stale PID file that blocks future starts (requiring manual cleanup).
- The daemon runs as a background Node.js process managed by platform supervisor (launchd on macOS, setsid on Linux, WinSW/NSSM on Windows).
- Config persists at `~/.claude-to-im/config.env` — survives across sessions.
