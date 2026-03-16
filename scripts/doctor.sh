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

# --- Helper: read a value from config.env ---
get_config() { grep "^$1=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//'; }

# --- Read runtime setting ---
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CTI_RUNTIME=$(get_config CTI_RUNTIME)
CTI_RUNTIME="${CTI_RUNTIME:-claude}"
echo "Runtime: $CTI_RUNTIME"
echo ""

# --- Claude CLI available (claude/auto modes) ---
if [ "$CTI_RUNTIME" = "claude" ] || [ "$CTI_RUNTIME" = "auto" ]; then
  # Resolve CLI path matching the daemon's checkCliCompatibility logic:
  #   - Version >= 2.x AND all required flags present
  #   - Skip candidates that fail either check (same as resolveClaudeCliPath)
  CLAUDE_PATH=""
  CLAUDE_VER=""
  CLAUDE_COMPAT=1
  REQUIRED_FLAGS="output-format input-format permission-mode setting-sources"

  # Helper: check if a candidate passes both version and flags checks.
  # Sets CLAUDE_PATH/CLAUDE_VER/CLAUDE_COMPAT on success.
  try_candidate() {
    local cand="$1"
    [ -x "$cand" ] || return 1
    local ver
    ver=$("$cand" --version 2>/dev/null || true)
    [ -z "$ver" ] && return 1
    local major
    major=$(echo "$ver" | sed -E -n 's/^[^0-9]*([0-9]+)\..*/\1/p' | head -1)
    if [ -z "$major" ] || ! [ "$major" -ge 2 ] 2>/dev/null; then
      echo "  (skipping $cand — version $ver is too old, need >= 2.x)"
      return 1
    fi
    # Version OK — check flags
    local help_text
    help_text=$("$cand" --help 2>&1 || true)
    for flag in $REQUIRED_FLAGS; do
      if ! echo "$help_text" | grep -q "$flag"; then
        echo "  (skipping $cand — version $ver OK but missing --$flag)"
        return 1
      fi
    done
    # Fully compatible
    CLAUDE_PATH="$cand"
    CLAUDE_VER="$ver"
    CLAUDE_COMPAT=0
    return 0
  }

  # 1. Explicit env var — if set, daemon uses it unconditionally (no fallback).
  #    Doctor must mirror this: report on this path only, never scan further.
  CTI_EXE=$(get_config CTI_CLAUDE_CODE_EXECUTABLE 2>/dev/null || true)
  if [ -n "$CTI_EXE" ]; then
    if [ -x "$CTI_EXE" ]; then
      if ! try_candidate "$CTI_EXE"; then
        # Explicit path is set but incompatible — daemon WILL use it and fail.
        # Report it as the selected CLI so the user sees the real problem.
        CLAUDE_PATH="$CTI_EXE"
        CLAUDE_VER=$("$CTI_EXE" --version 2>/dev/null || echo "unknown")
        # CLAUDE_COMPAT stays 1 (incompatible) — checks below will report failure
      fi
    else
      CLAUDE_PATH="$CTI_EXE"
      CLAUDE_VER="(not executable)"
    fi
  fi

  # 2. All PATH candidates (only if no explicit env var was set)
  if [ -z "$CTI_EXE" ] && [ -z "$CLAUDE_PATH" ]; then
    ALL_CLAUDES=$(which -a claude 2>/dev/null || true)
    for cand in $ALL_CLAUDES; do
      try_candidate "$cand" && break
    done
  fi

  # 3. Well-known locations (only if no explicit env var was set)
  if [ -z "$CTI_EXE" ] && [ -z "$CLAUDE_PATH" ]; then
    for cand in \
      "$HOME/.claude/local/claude" \
      "$HOME/.local/bin/claude" \
      "/usr/local/bin/claude" \
      "/opt/homebrew/bin/claude" \
      "$HOME/.npm-global/bin/claude"; do
      try_candidate "$cand" && break
    done
  fi

  if [ -n "$CLAUDE_PATH" ] && [ "$CLAUDE_COMPAT" = "0" ]; then
    check "Claude CLI compatible (${CLAUDE_VER} at ${CLAUDE_PATH})" 0
  elif [ -n "$CLAUDE_PATH" ]; then
    # Path found but incompatible (too old, missing flags, or not executable)
    check "Claude CLI compatible (${CLAUDE_VER} at ${CLAUDE_PATH} — incompatible, see above)" 1
  else
    if [ "$CTI_RUNTIME" = "claude" ]; then
      check "Claude CLI available (not found in PATH or common locations)" 1
    else
      check "Claude CLI available (not found — will use Codex fallback)" 0
    fi
  fi

  # --- Claude CLI authenticated ---
  # Skip this check if third-party API credentials are configured in config.env.
  # In that mode the bridge authenticates via ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN,
  # not via `claude auth login`, so a missing interactive login is expected and harmless.
  HAS_THIRD_PARTY_AUTH=false
  if [ -f "$CONFIG_FILE" ] && grep -qE "^ANTHROPIC_(API_KEY|AUTH_TOKEN)=" "$CONFIG_FILE" 2>/dev/null; then
    HAS_THIRD_PARTY_AUTH=true
  fi
  if [ -n "$CLAUDE_PATH" ] && [ "$CLAUDE_COMPAT" = "0" ]; then
    if [ "$HAS_THIRD_PARTY_AUTH" = "true" ]; then
      check "Claude CLI auth (skipped — using third-party API credentials from config.env)" 0
    else
      AUTH_OUT=$("$CLAUDE_PATH" auth status 2>&1 || true)
      if echo "$AUTH_OUT" | grep -qiE 'loggedIn.*true|logged.in'; then
        check "Claude CLI authenticated" 0
      else
        check "Claude CLI authenticated (run 'claude auth login')" 1
      fi
    fi
  fi

  # --- ANTHROPIC_* env reachability ---
  # Check whether ANTHROPIC_* vars are configured in config.env.
  # This is what matters for the daemon — the current shell env is irrelevant
  # because on macOS the daemon runs under launchd with only plist env vars.
  HAS_ANTHROPIC_CONFIG=false
  if [ -f "$CONFIG_FILE" ]; then
    if grep -q "^ANTHROPIC_" "$CONFIG_FILE" 2>/dev/null; then
      HAS_ANTHROPIC_CONFIG=true
    fi
  fi
  if [ "$HAS_ANTHROPIC_CONFIG" = "true" ]; then
    check "ANTHROPIC_* vars in config.env (third-party API provider)" 0

    PLIST_FILE="$HOME/Library/LaunchAgents/com.claude-to-im.bridge.plist"

    # On macOS, verify the launchd plist also has the vars
    if [ "$(uname -s)" = "Darwin" ] && [ -f "$PLIST_FILE" ]; then
      if grep -q "ANTHROPIC_" "$PLIST_FILE" 2>/dev/null; then
        check "ANTHROPIC_* vars in launchd plist" 0
      else
        check "ANTHROPIC_* vars in launchd plist (NOT present — restart bridge to regenerate plist)" 1
      fi
    fi

    # If bridge is running, verify the LIVE process has the vars.
    # The plist may be correct on disk but if the daemon hasn't been
    # restarted since the plist was regenerated, it still runs with the
    # old environment.
    BRIDGE_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
      # ps eww shows the process environment on macOS/Linux
      PROC_ENV=$(ps eww -p "$BRIDGE_PID" 2>/dev/null || true)
      if echo "$PROC_ENV" | grep -q "ANTHROPIC_"; then
        check "Running bridge process has ANTHROPIC_* env vars" 0
      else
        check "Running bridge process has ANTHROPIC_* env vars (NOT in process env — restart the bridge)" 1
      fi
    fi
  else
    check "ANTHROPIC_* vars in config.env (not set — OK if using default Anthropic auth)" 0
  fi

  # --- SDK cli.js resolvable ---
  SDK_CLI=""
  for candidate in \
    "$SKILL_DIR/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" \
    "$SKILL_DIR/node_modules/@anthropic-ai/claude-agent-sdk/dist/cli.js"; do
    if [ -f "$candidate" ]; then
      SDK_CLI="$candidate"
      break
    fi
  done
  if [ -n "$SDK_CLI" ]; then
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
if [ -f "$CONFIG_FILE" ]; then
  CTI_CHANNELS=$(get_config CTI_ENABLED_CHANNELS)

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

  # --- DingTalk ---
  if echo "$CTI_CHANNELS" | grep -q dingtalk; then
    DT_CLIENT_ID=$(get_config CTI_DINGTALK_CLIENT_ID)
    DT_CLIENT_SECRET=$(get_config CTI_DINGTALK_CLIENT_SECRET)
    if [ -n "$DT_CLIENT_ID" ] && [ -n "$DT_CLIENT_SECRET" ]; then
      # Validate by requesting an access token
      DT_RESULT=$(curl -s --max-time 5 -X POST "https://api.dingtalk.com/v1.0/oauth2/accessToken" \
        -H "Content-Type: application/json" \
        -d "{\"appKey\":\"${DT_CLIENT_ID}\",\"appSecret\":\"${DT_CLIENT_SECRET}\"}" 2>/dev/null || echo '{"accessToken":""}')
      if echo "$DT_RESULT" | grep -q '"accessToken"[[:space:]]*:[[:space:]]*"[^"]'; then
        check "DingTalk app credentials are valid" 0
      else
        check "DingTalk app credentials are valid (accessToken request failed)" 1
      fi
    else
      check "DingTalk app credentials configured" 1
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
