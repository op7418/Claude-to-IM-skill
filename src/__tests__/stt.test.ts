import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('transcribeAudioIfNeeded', () => {
  it('returns prompt unchanged when no audio paths present', async () => {
    const { transcribeAudioIfNeeded } = await import('../stt.js');
    const prompt = 'Hello, can you help me with this code?';
    const result = await transcribeAudioIfNeeded(prompt, 'gsk_test');
    assert.equal(result, prompt);
  });

  it('returns prompt unchanged when groqApiKey is empty', async () => {
    const { transcribeAudioIfNeeded } = await import('../stt.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-test-'));
    const audioPath = path.join(tmpDir, '1234567890_voice.ogg');
    fs.writeFileSync(audioPath, 'fake audio data');
    const prompt = `[User uploaded 1 file(s).]\n  - ${audioPath}`;
    try {
      const result = await transcribeAudioIfNeeded(prompt, '');
      assert.equal(result, prompt);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects .ogg audio path with AUDIO_PATH_REGEX', async () => {
    const { AUDIO_PATH_REGEX } = await import('../stt.js');
    const uploadPath = `/home/user/.claude-to-im/uploads/1710000000000_voice-message.ogg`;
    // Reset lastIndex since it's a global regex
    AUDIO_PATH_REGEX.lastIndex = 0;
    assert.ok(AUDIO_PATH_REGEX.test(uploadPath), 'should match .ogg in uploads dir');
  });

  it('does not match .pdf with AUDIO_PATH_REGEX', async () => {
    const { AUDIO_PATH_REGEX } = await import('../stt.js');
    const pdfPath = `/home/user/.claude-to-im/uploads/1710000000000_report.pdf`;
    AUDIO_PATH_REGEX.lastIndex = 0;
    assert.ok(!AUDIO_PATH_REGEX.test(pdfPath), 'should not match .pdf');
  });

  it('transcribes audio file and substitutes path in prompt', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-test-'));
    const audioPath = path.join(tmpDir, '1234567890_voice.ogg');
    fs.writeFileSync(audioPath, 'fake audio data');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: unknown, _opts: unknown) => ({
      ok: true,
      json: async () => ({ text: 'Hello from voice message' }),
    } as Response);

    try {
      const { transcribeAudioIfNeeded } = await import('../stt.js');
      const prompt = `[User uploaded 1 file(s)]\n  - ${audioPath}`;
      const result = await transcribeAudioIfNeeded(prompt, 'gsk_test');
      assert.ok(
        result.includes('[Voice message (transcribed): "Hello from voice message"]'),
        `Expected transcription substitution, got: ${result}`,
      );
      assert.ok(!result.includes(audioPath), 'Original path should be removed');
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('falls back gracefully when Groq API returns error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-test-'));
    const audioPath = path.join(tmpDir, '1234567890_voice.ogg');
    fs.writeFileSync(audioPath, 'fake audio data');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as unknown as Response);

    try {
      const { transcribeAudioIfNeeded } = await import('../stt.js');
      const prompt = `[User uploaded 1 file(s)]\n  - ${audioPath}`;
      const result = await transcribeAudioIfNeeded(prompt, 'gsk_bad_key');
      assert.equal(result, prompt);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('falls back gracefully when audio file does not exist on disk', async () => {
    const { transcribeAudioIfNeeded } = await import('../stt.js');
    const fakePath = path.join(os.tmpdir(), 'nonexistent_99999_voice.ogg');
    const prompt = `[User uploaded 1 file(s)]\n  - ${fakePath}`;
    const result = await transcribeAudioIfNeeded(prompt, 'gsk_test');
    assert.equal(result, prompt);
  });
});
