#!/usr/bin/env bash
# Patch claude-to-im feishu adapter: cardkit.v2 -> v1 REST API
# @larksuiteoapi/node-sdk only has cardkit.v1, the bundled code calls v2 which doesn't exist.
# This patches both .ts source and .js compiled output before build.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER_TS="$SKILL_DIR/node_modules/claude-to-im/src/lib/bridge/adapters/feishu-adapter.ts"
ADAPTER_JS="$SKILL_DIR/node_modules/claude-to-im/dist/lib/bridge/adapters/feishu-adapter.js"

patch_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "[patch-feishu] File not found: $file"
    return
  fi
  if grep -q "cardkit.v2" "$file"; then
    echo "[patch-feishu] Patching $file"
    if [[ "$file" == *.ts ]]; then
      sed -i '' 's|await (this.restClient as any).cardkit.v2.card.create({|await (this.restClient as any).request({ method: "POST", url: "/open-apis/cardkit/v1/cards",|g' "$file"
      sed -i '' 's|(this.restClient as any).cardkit.v2.card.streamContent({|(this.restClient as any).request({ method: "PUT", url: `/open-apis/cardkit/v1/cards/${cardId}/elements/streaming_content/content`,|g' "$file"
      sed -i '' 's|await (this.restClient as any).cardkit.v2.card.settings.streamingMode.set({|await (this.restClient as any).request({ method: "PATCH", url: `/open-apis/cardkit/v1/cards/${state.cardId}/settings`,|g' "$file"
      sed -i '' "s|data: { streaming_mode: false, sequence: state.sequence },|data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: state.sequence },|g" "$file"
      sed -i '' 's|await (this.restClient as any).cardkit.v2.card.update({|await (this.restClient as any).request({ method: "PUT", url: `/open-apis/cardkit/v1/cards/${state.cardId}`,|g' "$file"
    else
      sed -i '' 's|this.restClient.cardkit.v2.card.create({|this.restClient.request({ method: "POST", url: "/open-apis/cardkit/v1/cards",|g' "$file"
      sed -i '' 's|this.restClient.cardkit.v2.card.streamContent({|this.restClient.request({ method: "PUT", url: `/open-apis/cardkit/v1/cards/${cardId}/elements/streaming_content/content`,|g' "$file"
      sed -i '' 's|this.restClient.cardkit.v2.card.settings.streamingMode.set({|this.restClient.request({ method: "PATCH", url: `/open-apis/cardkit/v1/cards/${state.cardId}/settings`,|g' "$file"
      sed -i '' "s|data: { streaming_mode: false, sequence: state.sequence },|data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: state.sequence },|g" "$file"
      sed -i '' 's|this.restClient.cardkit.v2.card.update({|this.restClient.request({ method: "PUT", url: `/open-apis/cardkit/v1/cards/${state.cardId}`,|g' "$file"
    fi
    echo "[patch-feishu] Done"
  else
    echo "[patch-feishu] Already patched or no cardkit.v2 found in $file"
  fi
}

patch_file "$ADAPTER_TS"
patch_file "$ADAPTER_JS"
