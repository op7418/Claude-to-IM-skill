import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { CTI_HOME, loadConfig } from './config.js';
import { startLoginQr, pollLoginQrStatus } from './adapters/weixin/weixin-api.js';
import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL } from './adapters/weixin/weixin-types.js';
import { listWeixinAccounts, upsertWeixinAccount } from './weixin-store.js';

type LoginStatus = 'waiting' | 'scanned' | 'confirmed' | 'failed';

interface LoginSession {
  qrcode: string;
  qrImageUrl: string;
  status: LoginStatus;
  startedAt: number;
  refreshCount: number;
}

const MAX_REFRESHES = 3;
const QR_TTL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;
const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const HTML_PATH = path.join(RUNTIME_DIR, 'weixin-login.html');

function ensureRuntimeDir(): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildQrHtml(session: LoginSession, qrSvg: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Claude-to-IM WeChat Login</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
        background: linear-gradient(180deg, #f6fbf8 0%, #eef5ff 100%);
        color: #14213d;
      }
      .wrap {
        max-width: 760px;
        margin: 0 auto;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px 20px;
      }
      .card {
        width: 100%;
        background: rgba(255,255,255,0.92);
        border: 1px solid rgba(20,33,61,0.08);
        border-radius: 24px;
        box-shadow: 0 20px 50px rgba(36, 82, 167, 0.12);
        padding: 28px;
      }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.6; margin: 8px 0; }
      .qr {
        display: flex;
        justify-content: center;
        margin: 28px 0;
      }
      #qrcode {
        display: flex;
        justify-content: center;
      }
      #qrcode svg {
        width: 300px;
        height: 300px;
        border-radius: 18px;
        background: white;
        border: 1px solid rgba(20,33,61,0.08);
        padding: 16px;
      }
      ol {
        margin: 18px 0 0;
        padding-left: 22px;
      }
      code {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        background: #eef3ff;
        color: #2452a7;
      }
      .muted { color: #5b6b86; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>微信扫码登录 Claude-to-IM</h1>
        <p>请用手机微信扫描下面的二维码，并在手机上确认登录授权。</p>
        <p class="muted">如果二维码过期，CLI 会自动刷新这个页面内容；如果浏览器没有更新，请手动刷新一次。</p>
        <div class="qr">
          <div id="qrcode">${qrSvg}</div>
        </div>
        <ol>
          <li>打开手机微信扫一扫</li>
          <li>扫描页面二维码</li>
          <li>在手机上确认授权</li>
          <li>回到 CLI，等待显示登录成功</li>
        </ol>
        <p class="muted">HTML 文件：<code>${escapeHtml(HTML_PATH)}</code></p>
      </div>
    </div>
  </body>
</html>
`;
}

async function writeQrHtml(session: LoginSession): Promise<void> {
  ensureRuntimeDir();
  const qrSvg = await QRCode.toString(session.qrImageUrl, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 300,
  });
  fs.writeFileSync(HTML_PATH, buildQrHtml(session, qrSvg), 'utf-8');
}

function openQrHtml(): boolean {
  try {
    if (process.platform === 'darwin') {
      const child = spawn('open', [HTML_PATH], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', HTML_PATH], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    const child = spawn('xdg-open', [HTML_PATH], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function normalizeAccountId(rawAccountId: string): string {
  return rawAccountId.replace(/[@.]/g, '-');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSession(refreshCount: number, baseUrl?: string): Promise<LoginSession> {
  const response = await startLoginQr(baseUrl);
  if (!response.qrcode || !response.qrcode_img_content) {
    throw new Error('Failed to get QR code from WeChat server');
  }
  return {
    qrcode: response.qrcode,
    qrImageUrl: response.qrcode_img_content,
    status: 'waiting',
    startedAt: Date.now(),
    refreshCount,
  };
}

async function refreshSession(previous: LoginSession, baseUrl?: string): Promise<LoginSession> {
  if (previous.refreshCount >= MAX_REFRESHES) {
    throw new Error('QR code expired too many times. Please run the login helper again.');
  }
  const next = await createSession(previous.refreshCount + 1, baseUrl);
  await writeQrHtml(next);
  openQrHtml();
  console.log(`[weixin-login] QR code refreshed (${next.refreshCount}/${MAX_REFRESHES})`);
  return next;
}

export async function runWeixinLogin(): Promise<{ accountId: string; htmlPath: string }> {
  ensureRuntimeDir();
  const config = loadConfig();
  let session = await createSession(0, config.weixinBaseUrl);
  await writeQrHtml(session);
  const opened = openQrHtml();

  console.log('[weixin-login] WeChat QR login started');
  console.log(`[weixin-login] QR page: ${HTML_PATH}`);
  if (!opened) {
    console.log('[weixin-login] Auto-open failed. Open the HTML file above manually in your browser.');
  }

  let lastStatus: LoginStatus = session.status;

  while (true) {
    if (Date.now() - session.startedAt > QR_TTL_MS) {
      session = await refreshSession(session, config.weixinBaseUrl);
      lastStatus = session.status;
    }

    const response = await pollLoginQrStatus(session.qrcode, config.weixinBaseUrl);
    switch (response.status) {
      case 'wait':
        session.status = 'waiting';
        break;
      case 'scaned':
        session.status = 'scanned';
        break;
      case 'confirmed': {
        if (!response.bot_token || !response.ilink_bot_id) {
          throw new Error('QR login confirmed, but WeChat did not return bot credentials.');
        }
        session.status = 'confirmed';
        const accountId = normalizeAccountId(response.ilink_bot_id);
        const previousAccount = listWeixinAccounts()[0];
        upsertWeixinAccount({
          accountId,
          userId: response.ilink_user_id || '',
          baseUrl: config.weixinBaseUrl || response.baseurl || DEFAULT_BASE_URL,
          cdnBaseUrl: config.weixinCdnBaseUrl || DEFAULT_CDN_BASE_URL,
          token: response.bot_token,
          name: accountId,
          enabled: true,
        });
        console.log(`[weixin-login] Login successful. Saved linked account ${accountId}`);
        if (previousAccount && previousAccount.accountId !== accountId) {
          console.log(`[weixin-login] Replaced previous local account ${previousAccount.accountId}`);
        }
        console.log('[weixin-login] You can now enable the `weixin` channel and start the bridge.');
        return { accountId, htmlPath: HTML_PATH };
      }
      case 'expired':
        session = await refreshSession(session, config.weixinBaseUrl);
        lastStatus = session.status;
        continue;
      default:
        session.status = 'waiting';
        break;
    }

    if (session.status !== lastStatus) {
      if (session.status === 'scanned') {
        console.log('[weixin-login] QR scanned. Please confirm the login in WeChat.');
      } else if (session.status === 'waiting') {
        console.log('[weixin-login] Waiting for QR scan...');
      }
      lastStatus = session.status;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

const isMainModule = (() => {
  const entry = process.argv[1];
  return !!entry && path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname);
})();

if (isMainModule) {
  runWeixinLogin().catch((err) => {
    console.error('[weixin-login] Failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
