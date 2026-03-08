/**
 * Speech-to-Text transcription via Groq Whisper API.
 *
 * Scans the prompt for audio file paths saved by the bridge adapters
 * and replaces each one with the Groq-transcribed text.
 */

import fs from 'node:fs';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';

/**
 * Matches absolute audio file paths anywhere in a string.
 * The bridge saves files as: <uploads_dir>/<timestamp>_<safeName>.<ext>
 * We match any absolute path where a numeric timestamp precedes the filename.
 *
 * IMPORTANT: This regex uses the `g` flag. Always reset lastIndex before reuse,
 * or use String.prototype.matchAll() which resets it automatically.
 */
export const AUDIO_PATH_REGEX =
  /\/[^\s"']+\/\d+_[^\s"']+\.(ogg|oga|mp3|mp4|wav|m4a|webm|flac)/g;

/**
 * Transcribe all audio file paths found in `prompt` using Groq Whisper.
 * Returns the prompt with paths replaced by transcription text.
 *
 * Graceful fallback: if `groqApiKey` is empty, file is missing, or
 * Groq returns an error, the original path is left unchanged.
 */
export async function transcribeAudioIfNeeded(
  prompt: string,
  groqApiKey: string,
): Promise<string> {
  if (!groqApiKey) return prompt;

  const matches = [...prompt.matchAll(AUDIO_PATH_REGEX)];
  if (matches.length === 0) return prompt;

  let result = prompt;

  for (const match of matches) {
    const filePath = match[0];
    const transcription = await transcribeFile(filePath, groqApiKey);
    if (transcription === null) continue;
    // replace() without /g replaces the first remaining occurrence each iteration,
    // correctly handling duplicate paths when matchAll yields them multiple times.
    result = result.replace(filePath, `[Voice message (transcribed): "${transcription}"]`);
  }

  return result;
}

/**
 * POST a single audio file to Groq and return the transcribed text.
 * Returns null on any error (network, API error, parse failure).
 */
async function transcribeFile(
  filePath: string,
  groqApiKey: string,
): Promise<string | null> {
  try {
    const fileBuffer = await fs.promises.readFile(filePath);
    const fileName = filePath.split('/').pop() ?? 'audio.ogg';
    const blob = new Blob([fileBuffer]);

    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('model', GROQ_STT_MODEL);

    const response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}` },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`[stt] Groq API error ${response.status} for ${filePath}: ${body}`);
      return null;
    }

    const data = (await response.json()) as { text?: string };
    return data.text ?? null;
  } catch (err) {
    console.warn(`[stt] Transcription failed for ${filePath}:`, err);
    return null;
  }
}
