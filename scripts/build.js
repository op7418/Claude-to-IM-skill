import * as esbuild from 'esbuild';

const sharedOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    // SDK must stay external — it spawns a CLI subprocess and resolves
    // dist/cli.js relative to its own package location. Bundling it
    // breaks that path resolution.
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    // discord.js optional native deps
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
};

await esbuild.build({
  ...sharedOptions,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/daemon.mjs',
});

await esbuild.build({
  ...sharedOptions,
  entryPoints: ['src/weixin-login.ts'],
  outfile: 'dist/weixin-login.mjs',
});

console.log('Built dist/daemon.mjs');
console.log('Built dist/weixin-login.mjs');
