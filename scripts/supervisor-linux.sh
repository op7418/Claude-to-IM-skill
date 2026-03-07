#!/usr/bin/env bash
# Linux supervisor — setsid/nohup fallback process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

# ── Environment helpers ──

# Export Kimi-related env vars for the daemon process
export_kimi_env() {
  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  case "$runtime" in
    kimi|auto)
      for var in KIMI_API_KEY KIMI_BASE_URL KIMI_CLI_PATH CTI_KIMI_EXECUTABLE; do
        local val="${!var:-}"
        [ -z "$val" ] && continue
        export "$var=$val"
      done
      ;;
  esac
}

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  # Export runtime-specific env vars before starting
  export_kimi_env

  if command -v setsid >/dev/null 2>&1; then
    setsid node "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup node "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  # Fallback: write shell $! as PID; main.ts will overwrite with real PID
  echo $! > "$PID_FILE"
}

supervisor_stop() {
  local pid
  pid=$(read_pid)
  if [ -z "$pid" ]; then echo "No bridge running"; return 0; fi
  if pid_alive "$pid"; then
    kill "$pid"
    for _ in $(seq 1 10); do
      pid_alive "$pid" || break
      sleep 1
    done
    pid_alive "$pid" && kill -9 "$pid"
    echo "Bridge stopped"
  else
    echo "Bridge was not running (stale PID file)"
  fi
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  # Linux fallback has no service manager; always false
  return 1
}

supervisor_status_extra() {
  # No extra status for Linux fallback
  :
}

supervisor_is_running() {
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
