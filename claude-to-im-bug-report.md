# Claude-to-IM Skill Bug Report

## Environment
- macOS Darwin 24.6.0
- Node.js v22.19.0
- Claude Code 2.1.66
- claude-to-im-skill v0.1.0
- Third-party API via `ANTHROPIC_BASE_URL`

## Bug 1: Node.js fetch fails to connect to Telegram API (IPv6)

**Symptom:** Telegram adapter reports `Polling error: fetch failed` and `getMe failed ... timeout` continuously. Bot never receives messages.

**Root Cause:** Node.js 22's built-in `fetch` (undici) defaults to IPv6 when available. In some network environments, IPv6 routes to `api.telegram.org` are unreachable while IPv4 works fine. `curl` succeeds because it defaults to IPv4. The `--dns-result-order=ipv4first` Node.js flag does NOT affect undici's fetch.

**Fix:** In `src/main.ts`, add at the top:
```typescript
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));
```

Then rebuild: `npm run build`

**Files changed:** `src/main.ts`

---

## Bug 2: config.env uses wrong variable names

**Symptom:** `No adapters started successfully, bridge not activated` — daemon ignores all channel config.

**Root Cause:** The setup wizard (SKILL.md) generates config with variable names like `ENABLED_CHANNELS`, `TELEGRAM_BOT_TOKEN`, but the daemon code expects `CTI_` prefixed names like `CTI_ENABLED_CHANNELS`, `CTI_TG_BOT_TOKEN`.

**Fix:** Ensure config.env uses `CTI_` prefixed variable names matching `config.env.example`.

**Files affected:** Setup wizard instructions in `SKILL.md`

---

## Bug 3: ANTHROPIC_AUTH_TOKEN not passed through to launchd

**Symptom:** `Claude Code process exited with code 1` — SDK fails to call Claude CLI because auth credentials are missing in the daemon process.

**Root Cause (3a):** `daemon.sh` runs `clean_env` which strips all `ANTHROPIC_*` env vars before `config.env` is loaded. Even with `CTI_ANTHROPIC_PASSTHROUGH=true` in config.env, the flag isn't set in the environment when `clean_env` runs.

**Fix (3a):** In `daemon.sh`, source `config.env` BEFORE calling `clean_env`:
```bash
# Load config.env first
if [ -f "$CTI_HOME/config.env" ]; then
  set -a
  . "$CTI_HOME/config.env"
  set +a
fi
clean_env
```

**Root Cause (3b):** `supervisor-macos.sh` `build_env_dict()` only forwards `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`, but not `ANTHROPIC_AUTH_TOKEN`. Users with third-party API proxies use `ANTHROPIC_AUTH_TOKEN` for authentication.

**Fix (3b):** In `supervisor-macos.sh`, add `ANTHROPIC_AUTH_TOKEN` to the passthrough list:
```bash
for var in ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN; do
```

**Files changed:** `scripts/daemon.sh`, `scripts/supervisor-macos.sh`
