#!/usr/bin/env bash
set -euo pipefail
CTI_HOME="$HOME/.claude-to-im"
CONFIG_FILE="$CTI_HOME/config.env"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
LOG_FILE="$CTI_HOME/logs/bridge.log"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "[OK]   $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label"
    FAIL=$((FAIL + 1))
  fi
}

# --- Node.js version ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'))" 0
  else
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'), need >= 20)" 1
  fi
else
  check "Node.js installed" 1
fi

# --- Read runtime setting ---
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CTI_RUNTIME=$(grep "^CTI_RUNTIME=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"')
CTI_RUNTIME="${CTI_RUNTIME:-claude}"
echo "Runtime: $CTI_RUNTIME"
echo ""

# --- Claude CLI available (claude/auto modes) ---
if [ "$CTI_RUNTIME" = "claude" ] || [ "$CTI_RUNTIME" = "auto" ]; then
  if command -v claude &>/dev/null; then
    CLAUDE_VER=$(claude --version 2>/dev/null || echo "unknown")
    check "Claude CLI available (${CLAUDE_VER})" 0
  else
    if [ "$CTI_RUNTIME" = "claude" ]; then
      check "Claude CLI available (not found in PATH)" 1
    else
      check "Claude CLI available (not found — will use Codex fallback)" 0
    fi
  fi

  # --- SDK cli.js resolvable ---
  SDK_CLI="$SKILL_DIR/node_modules/@anthropic-ai/claude-agent-sdk/dist/cli.js"
  if [ -f "$SDK_CLI" ]; then
    check "Claude SDK cli.js exists ($SDK_CLI)" 0
  else
    if [ "$CTI_RUNTIME" = "claude" ]; then
      check "Claude SDK cli.js exists (not found — run 'npm install' in $SKILL_DIR)" 1
    else
      check "Claude SDK cli.js exists (not found — OK for auto/codex mode)" 0
    fi
  fi
fi

# --- Codex checks (codex/auto modes) ---
if [ "$CTI_RUNTIME" = "codex" ] || [ "$CTI_RUNTIME" = "auto" ]; then
  if command -v codex &>/dev/null; then
    CODEX_VER=$(codex --version 2>/dev/null || echo "unknown")
    check "Codex CLI available (${CODEX_VER})" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "Codex CLI available (not found in PATH)" 1
    else
      check "Codex CLI available (not found — will use Claude)" 0
    fi
  fi

  # Check @openai/codex-sdk
  CODEX_SDK="$SKILL_DIR/node_modules/@openai/codex-sdk"
  if [ -d "$CODEX_SDK" ]; then
    check "@openai/codex-sdk installed" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "@openai/codex-sdk installed (not found — run 'npm install' in $SKILL_DIR)" 1
    else
      check "@openai/codex-sdk installed (not found — OK for auto/claude mode)" 0
    fi
  fi

  # Check Codex auth: any of CTI_CODEX_API_KEY / CODEX_API_KEY / OPENAI_API_KEY,
  # or `codex auth status` showing logged-in (interactive login).
  CODEX_AUTH=1
  if [ -n "${CTI_CODEX_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; then
    CODEX_AUTH=0
  elif command -v codex &>/dev/null; then
    CODEX_AUTH_OUT=$(codex auth status 2>&1 || true)
    if echo "$CODEX_AUTH_OUT" | grep -qiE 'logged.in|authenticated'; then
      CODEX_AUTH=0
    fi
  fi
  if [ "$CODEX_AUTH" = "0" ]; then
    check "Codex auth available (API key or login)" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "Codex auth available (set OPENAI_API_KEY or run 'codex auth login')" 1
    else
      check "Codex auth available (not found — needed only for Codex fallback)" 0
    fi
  fi
fi

# --- dist/daemon.mjs freshness ---
DAEMON_MJS="$SKILL_DIR/dist/daemon.mjs"
if [ -f "$DAEMON_MJS" ]; then
  STALE_SRC=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$DAEMON_MJS" 2>/dev/null | head -1)
  if [ -z "$STALE_SRC" ]; then
    check "dist/daemon.mjs is up to date" 0
  else
    check "dist/daemon.mjs is stale (src changed, run 'npm run build')" 1
  fi
else
  check "dist/daemon.mjs exists (not built — run 'npm run build')" 1
fi

# --- config.env exists ---
if [ -f "$CONFIG_FILE" ]; then
  check "config.env exists" 0
else
  check "config.env exists ($CONFIG_FILE not found)" 1
fi

# --- config.env permissions ---
if [ -f "$CONFIG_FILE" ]; then
  PERMS=$(stat -f "%Lp" "$CONFIG_FILE" 2>/dev/null || stat -c "%a" "$CONFIG_FILE" 2>/dev/null || echo "unknown")
  if [ "$PERMS" = "600" ]; then
    check "config.env permissions are 600" 0
  else
    check "config.env permissions are 600 (currently $PERMS)" 1
  fi
fi

# --- Load config for channel checks ---
get_config() { grep "^$1=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//'; }

if [ -f "$CONFIG_FILE" ]; then
  CTI_CHANNELS=$(get_config CTI_ENABLED_CHANNELS)
  CTI_DEFAULT_WORKDIR=$(get_config CTI_DEFAULT_WORKDIR)
  CTI_CODEX_SKIP_GIT_REPO_CHECK=$(get_config CTI_CODEX_SKIP_GIT_REPO_CHECK)

  if [ "$CTI_RUNTIME" = "codex" ] || [ "$CTI_RUNTIME" = "auto" ]; then
    if [ -n "$CTI_DEFAULT_WORKDIR" ]; then
      if [ -d "$CTI_DEFAULT_WORKDIR" ]; then
        check "Default work directory exists" 0
        if git -C "$CTI_DEFAULT_WORKDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
          check "Default work directory is a Git repo" 0
        else
          if [ "${CTI_CODEX_SKIP_GIT_REPO_CHECK:-}" = "true" ]; then
            check "Default work directory is non-git but skip check is enabled" 0
          else
            check "Default work directory is a Git repo (or set CTI_CODEX_SKIP_GIT_REPO_CHECK=true)" 1
          fi
        fi
      else
        check "Default work directory exists ($CTI_DEFAULT_WORKDIR)" 1
      fi
    else
      check "Default work directory configured" 1
    fi
  fi

  # --- Telegram ---
  if echo "$CTI_CHANNELS" | grep -q telegram; then
    TG_TOKEN=$(get_config CTI_TG_BOT_TOKEN)
    if [ -n "$TG_TOKEN" ]; then
      TG_RESULT=$(curl -s --max-time 5 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
      if echo "$TG_RESULT" | grep -q '"ok":true'; then
        check "Telegram bot token is valid" 0
      else
        check "Telegram bot token is valid (getMe failed)" 1
      fi
    else
      check "Telegram bot token configured" 1
    fi
  fi

  # --- Feishu ---
  if echo "$CTI_CHANNELS" | grep -q feishu; then
    FS_APP_ID=$(get_config CTI_FEISHU_APP_ID)
    FS_SECRET=$(get_config CTI_FEISHU_APP_SECRET)
    FS_DOMAIN=$(get_config CTI_FEISHU_DOMAIN)
    FS_DOMAIN="${FS_DOMAIN:-https://open.feishu.cn}"
    if [ -n "$FS_APP_ID" ] && [ -n "$FS_SECRET" ]; then
      FEISHU_RESULT=$(curl -s --max-time 5 -X POST "${FS_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"${FS_APP_ID}\",\"app_secret\":\"${FS_SECRET}\"}" 2>/dev/null || echo '{"code":1}')
      if echo "$FEISHU_RESULT" | grep -q '"code"[[:space:]]*:[[:space:]]*0'; then
        check "Feishu app credentials are valid" 0
      else
        check "Feishu app credentials are valid (token request failed)" 1
      fi
    else
      check "Feishu app credentials configured" 1
    fi
  fi

  # --- QQ ---
  if echo "$CTI_CHANNELS" | grep -q qq; then
    QQ_APP_ID=$(get_config CTI_QQ_APP_ID)
    QQ_APP_SECRET=$(get_config CTI_QQ_APP_SECRET)
    if [ -n "$QQ_APP_ID" ] && [ -n "$QQ_APP_SECRET" ]; then
      QQ_TOKEN_RESULT=$(curl -s --max-time 10 -X POST "https://bots.qq.com/app/getAppAccessToken" \
        -H "Content-Type: application/json" \
        -d "{\"appId\":\"${QQ_APP_ID}\",\"clientSecret\":\"${QQ_APP_SECRET}\"}" 2>/dev/null || echo '{}')
      QQ_ACCESS_TOKEN=$(echo "$QQ_TOKEN_RESULT" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      if [ -n "$QQ_ACCESS_TOKEN" ]; then
        check "QQ app credentials are valid (access_token obtained)" 0
        # Verify gateway availability
        QQ_GW_RESULT=$(curl -s --max-time 10 "https://api.sgroup.qq.com/gateway" \
          -H "Authorization: QQBot ${QQ_ACCESS_TOKEN}" 2>/dev/null || echo '{}')
        if echo "$QQ_GW_RESULT" | grep -q '"url"'; then
          check "QQ gateway is reachable" 0
        else
          check "QQ gateway is reachable (GET /gateway failed)" 1
        fi
      else
        check "QQ app credentials are valid (getAppAccessToken failed)" 1
      fi
    else
      check "QQ app credentials configured" 1
    fi
  fi

  # --- WeCom ---
  if echo "$CTI_CHANNELS" | grep -q wecom; then
    WECOM_BOT_ID=$(get_config CTI_WECOM_BOT_ID)
    WECOM_SECRET=$(get_config CTI_WECOM_SECRET)
    if [ -d "$SKILL_DIR/node_modules/@wecom/aibot-node-sdk" ]; then
      check "@wecom/aibot-node-sdk installed" 0
    else
      check "@wecom/aibot-node-sdk installed" 1
    fi
    if [ -n "$WECOM_BOT_ID" ] && [ -n "$WECOM_SECRET" ]; then
      check "WeCom bot credentials configured" 0
    else
      check "WeCom bot credentials configured" 1
    fi
  fi

  # --- Discord ---
  if echo "$CTI_CHANNELS" | grep -q discord; then
    DC_TOKEN=$(get_config CTI_DISCORD_BOT_TOKEN)
    if [ -n "$DC_TOKEN" ]; then
      if echo "${DC_TOKEN}" | grep -qE '^[A-Za-z0-9_-]{20,}\.'; then
        check "Discord bot token format" 0
      else
        check "Discord bot token format (does not match expected pattern)" 1
      fi
    else
      check "Discord bot token configured" 1
    fi
  fi
fi

# --- Log directory writable ---
LOG_DIR="$CTI_HOME/logs"
if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
  check "Log directory is writable" 0
else
  check "Log directory is writable ($LOG_DIR)" 1
fi

# --- PID file consistency ---
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    check "PID file consistent (process $PID is running)" 0
  else
    check "PID file consistent (stale PID $PID, process not running)" 1
  fi
else
  check "PID file consistency (no PID file, OK)" 0
fi

# --- Recent errors in log ---
if [ -f "$LOG_FILE" ]; then
  ERROR_COUNT=$(tail -50 "$LOG_FILE" | grep -ciE 'ERROR|Fatal' || true)
  if [ "$ERROR_COUNT" -eq 0 ]; then
    check "No recent errors in log (last 50 lines)" 0
  else
    check "No recent errors in log (found $ERROR_COUNT ERROR/Fatal lines)" 1
  fi
else
  check "Log file exists (not yet created)" 0
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Common fixes:"
  echo "  SDK cli.js missing    → cd $SKILL_DIR && npm install"
  echo "  dist/daemon.mjs stale → cd $SKILL_DIR && npm run build"
  echo "  config.env missing    → run setup wizard"
  echo "  Stale PID file        → run stop, then start"
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
