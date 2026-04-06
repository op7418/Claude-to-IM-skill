#!/usr/bin/env bash
# macOS supervisor — launchd-based process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

PLIST_DIR="$HOME/Library/LaunchAgents"

launchd_label() {
  echo "${CTI_LAUNCHD_LABEL:-com.claude-to-im.bridge}"
}

plist_file() {
  local label
  label="$(launchd_label)"
  echo "$PLIST_DIR/$label.plist"
}

# ── launchd helpers ──

# Collect env vars that should be forwarded into the plist.
# We honour clean_env() logic by reading *after* clean_env runs.
build_env_dict() {
  local indent="            "
  local dict=""

  # Always forward basics
  for var in HOME PATH USER SHELL LANG TMPDIR; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
  done

  # Forward CTI_* vars
  while IFS='=' read -r name val; do
    case "$name" in CTI_*)
      dict+="${indent}<key>${name}</key>\n${indent}<string>${val}</string>\n"
      ;; esac
  done < <(env)

  # Forward runtime-specific API keys
  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  case "$runtime" in
    codex|auto)
      for var in OPENAI_API_KEY CODEX_API_KEY CTI_CODEX_API_KEY CTI_CODEX_BASE_URL; do
        local val="${!var:-}"
        [ -z "$val" ] && continue
        dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
      done
      ;;
  esac
  case "$runtime" in
    claude|auto)
      # Auto-forward all ANTHROPIC_* env vars (sourced from config.env by daemon.sh).
      # Third-party API providers need these to reach the CLI subprocess.
      while IFS='=' read -r name val; do
        case "$name" in ANTHROPIC_*)
          dict+="${indent}<key>${name}</key>\n${indent}<string>${val}</string>\n"
          ;; esac
      done < <(env)
      ;;
  esac

  echo -e "$dict"
}

generate_plist() {
  local node_path
  local label
  local plist_file_path
  node_path=$(command -v node)
  label="$(launchd_label)"
  plist_file_path="$(plist_file)"

  mkdir -p "$PLIST_DIR"
  local env_dict
  env_dict=$(build_env_dict)

  cat > "$plist_file_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${node_path}</string>
        <string>${SKILL_DIR}/dist/daemon.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>

    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
${env_dict}    </dict>
</dict>
</plist>
PLIST
}

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  local label
  local plist_file_path
  label="$(launchd_label)"
  plist_file_path="$(plist_file)"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  generate_plist
  launchctl bootstrap "gui/$(id -u)" "$plist_file_path"
  launchctl kickstart -k "gui/$(id -u)/$label"
}

supervisor_stop() {
  local label
  label="$(launchd_label)"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  local label
  label="$(launchd_label)"
  launchctl print "gui/$(id -u)/$label" &>/dev/null
}

supervisor_status_extra() {
  if supervisor_is_managed; then
    local label
    label="$(launchd_label)"
    echo "Bridge is registered with launchd ($label)"
    # Extract PID from launchctl as the authoritative source
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      echo "launchd reports PID: $lc_pid"
    fi
  fi
}

# Override: on macOS, check launchctl first, then fall back to PID file
supervisor_is_running() {
  # Primary: launchctl knows the process
  if supervisor_is_managed; then
    local label
    local lc_pid
    label="$(launchd_label)"
    lc_pid=$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      return 0
    fi
  fi
  # Fallback: PID file
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
