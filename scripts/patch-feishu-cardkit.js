// Patch claude-to-im feishu adapter: cardkit.v2 -> v1 REST API
// @larksuiteoapi/node-sdk only has cardkit.v1, the bundled code calls v2 which doesn't exist.
// This patches both .ts source and .js compiled output before build.

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..');

const files = [
  join(SKILL_DIR, 'node_modules', 'claude-to-im', 'src', 'lib', 'bridge', 'adapters', 'feishu-adapter.ts'),
  join(SKILL_DIR, 'node_modules', 'claude-to-im', 'dist', 'lib', 'bridge', 'adapters', 'feishu-adapter.js'),
];

const replacements = [
  {
    // card.create -> POST /open-apis/cardkit/v1/cards
    from: /\.cardkit\.v2\.card\.create\(\{/,
    to: (isTs) => isTs
      ? '.request({ method: "POST", url: "/open-apis/cardkit/v1/cards",'
      : '.request({ method: "POST", url: "/open-apis/cardkit/v1/cards",',
  },
  {
    // card.streamContent -> PUT .../elements/streaming_content/content
    from: /\.cardkit\.v2\.card\.streamContent\(\{/,
    to: () => '.request({ method: "PUT", url: `/open-apis/cardkit/v1/cards/${cardId}/elements/streaming_content/content`,',
  },
  {
    // card.settings.streamingMode.set -> PATCH .../settings
    from: /\.cardkit\.v2\.card\.settings\.streamingMode\.set\(\{/,
    to: (isTs) => isTs
      ? '.request({ method: "PATCH", url: `/open-apis/cardkit/v1/cards/${state.cardId}/settings`,'
      : '.request({ method: "PATCH", url: `/open-apis/cardkit/v1/cards/${state.cardId}/settings`,',
  },
  {
    // Fix settings request body format: streaming_mode must be nested in config
    from: /data: \{ streaming_mode: false, sequence: state\.sequence \}/,
    to: () => 'data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: state.sequence }',
  },
  {
    // card.update -> PUT /open-apis/cardkit/v1/cards/:card_id
    from: /\.cardkit\.v2\.card\.update\(\{/,
    to: (isTs) => isTs
      ? '.request({ method: "PUT", url: `/open-apis/cardkit/v1/cards/${state.cardId}`,'
      : '.request({ method: "PUT", url: `/open-apis/cardkit/v1/cards/${state.cardId}`,',
  },
];

for (const file of files) {
  const isTs = file.endsWith('.ts');
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    console.log(`[patch-feishu] File not found: ${file}`);
    continue;
  }

  if (!content.includes('cardkit.v2')) {
    console.log(`[patch-feishu] Already patched or no cardkit.v2 in ${file}`);
    continue;
  }

  console.log(`[patch-feishu] Patching ${file}`);
  for (const { from, to } of replacements) {
    content = content.replace(from, to(isTs));
  }

  if (!content.includes('cardkit.v2')) {
    writeFileSync(file, content, 'utf-8');
    console.log('[patch-feishu] Done');
  } else {
    console.error('[patch-feishu] WARNING: cardkit.v2 still present after patching!');
    process.exit(1);
  }
}
