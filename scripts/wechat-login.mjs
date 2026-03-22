#!/usr/bin/env node
/**
 * WeChat QR Login — standalone script for the setup wizard.
 *
 * Displays a QR code in the terminal, waits for the user to scan with
 * iOS WeChat, and outputs the credentials as JSON to stdout.
 *
 * Usage:
 *   node scripts/wechat-login.mjs
 *
 * On success, prints a single JSON line to stdout:
 *   {"token":"...","baseUrl":"...","accountId":"...","userId":"..."}
 *
 * All progress/status messages go to stderr so they don't pollute
 * the JSON output that the setup wizard parses.
 */

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';

function log(msg) {
  process.stderr.write(`[wechat-login] ${msg}\n`);
}

async function fetchQRCode() {
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return await res.json();
}

async function pollQRStatus(qrcode) {
  const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  try {
    const res = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') return { status: 'wait' };
    throw err;
  }
}

/**
 * Render a minimal QR code in the terminal using Unicode block characters.
 * Falls back to printing the URL if rendering fails.
 */
async function renderQR(text) {
  try {
    // Try dynamic import of qrcode-terminal (optional dependency)
    const qrterm = await import('qrcode-terminal');
    await new Promise((resolve) => {
      qrterm.default.generate(text, { small: true }, (qr) => {
        process.stderr.write(qr + '\n');
        resolve();
      });
    });
  } catch {
    // Fallback: print the URL for the user to open manually
    log(`Open this URL in a browser to see the QR code:`);
    log(text);
  }
}

async function main() {
  log('Fetching WeChat login QR code...');

  const qrResp = await fetchQRCode();

  log('');
  log('Scan the QR code below with WeChat (iOS):');
  log('');
  await renderQR(qrResp.qrcode_img_content);
  log('');
  log('Waiting for scan...');

  const deadline = Date.now() + 480_000; // 8 min timeout
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(qrResp.qrcode);

    switch (status.status) {
      case 'wait':
        break;
      case 'scaned':
        if (!scannedPrinted) {
          log('Scanned! Please confirm in WeChat...');
          scannedPrinted = true;
        }
        break;
      case 'expired':
        log('QR code expired. Please try again.');
        process.exit(1);
        break;
      case 'confirmed': {
        if (!status.ilink_bot_id || !status.bot_token) {
          log('Login confirmed but server did not return credentials.');
          process.exit(1);
        }

        const result = {
          token: status.bot_token,
          baseUrl: status.baseurl || BASE_URL,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id || '',
        };

        // Output JSON to stdout (the only stdout output)
        console.log(JSON.stringify(result));

        log('');
        log(`Login successful!`);
        log(`  Account ID: ${result.accountId}`);
        log(`  User ID:    ${result.userId}`);
        process.exit(0);
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  log('Login timed out. Please try again.');
  process.exit(1);
}

main().catch((err) => {
  log(`Error: ${err.message || err}`);
  process.exit(1);
});
