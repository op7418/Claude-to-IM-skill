#!/usr/bin/env bash
# Linux supervisor — setsid/nohup fallback process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  # Fix for Feishu WebSocket 502 loop on China mainland servers with proxychains.
  # When both proxychains and https_proxy env vars exist, Feishu SDK's WSClient
  # creates a double-proxy loop (proxy -> proxy -> self -> 502).
  # Solution: unset HTTP proxy env vars so proxychains is the sole proxy mechanism.
  # This allows Discord (needs proxy) and Feishu (direct-reachable) to both work.
  export no_proxy="${no_proxy:+$no_proxy,}*.feishu.cn,*.larksuite.com,*.bytedance.com,*.bytedns1.com,*.cdngslb.com,*.queniuyk.com"
  unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY

  local node_cmd="node"
  if command -v proxychains4 >/dev/null 2>&1; then
    node_cmd="proxychains4 node"
  fi

  if command -v setsid >/dev/null 2>&1; then
    setsid $node_cmd "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup $node_cmd "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
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
