#!/usr/bin/env bash
# Linux supervisor — setsid/nohup fallback process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  local NODE_ARGS=()

  # Optional: use system CA bundle (helps on distros with custom cert stores, e.g. SteamOS)
  if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
  fi

  # Optional: force IPv4-only DNS to fix ENETUNREACH on IPv6-broken networks (e.g. SteamOS with NVM)
  # Set CTI_FORCE_IPV4=1 in your config.env to enable.
  if [ "${CTI_FORCE_IPV4:-0}" = "1" ]; then
    NODE_ARGS+=(--require "$SKILL_DIR/scripts/ipv4-patch.cjs")
  fi

  if command -v setsid >/dev/null 2>&1; then
    setsid node "${NODE_ARGS[@]}" "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup node "${NODE_ARGS[@]}" "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
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
