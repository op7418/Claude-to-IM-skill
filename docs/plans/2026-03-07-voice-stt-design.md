# Voice-to-Text (STT) Design — 2026-03-07

## Problem

Discord voice messages and audio file uploads are downloaded to `~/.claude-to-im/uploads/` as non-image files. Their local path is appended to the prompt text forwarded to Claude Code, which cannot process audio. The result is a useless file path reference.

## Goal

Automatically transcribe audio attachments via Groq Whisper API before forwarding to Claude, replacing the file path with the transcribed text.

## Approach

Intercept in `src/llm-provider.ts` — before calling the Claude SDK, scan the prompt for audio file paths and transcribe them using Groq. Logic lives entirely in local `src/`, no upstream (`claude-to-im`) modification needed.

## Architecture

### New module: `src/stt.ts`

- Exports `transcribeAudioIfNeeded(prompt: string, groqApiKey: string): Promise<string>`
- Regex-detects audio file paths embedded in prompt text:
  ```
  ~/.claude-to-im/uploads/\d+_[\w.-]+\.(ogg|mp3|mp4|wav|m4a|webm|flac|oga)
  ```
- For each match: streams file from disk via `FormData`, POSTs to Groq API, replaces path with transcription
- If no audio paths found: returns prompt unchanged (zero overhead)

### Groq API details

- Endpoint: `POST https://api.groq.com/openai/v1/audio/transcriptions`
- Model: `whisper-large-v3-turbo` (fast, multilingual)
- Auth: `Authorization: Bearer <CTI_GROQ_API_KEY>`

### Substitution format

```
[Voice message (transcribed): "Hello, can you help me with..."]
```

### Integration point: `src/llm-provider.ts`

In `streamChat()`, before building the SDK prompt:
```typescript
const transcribedPrompt = await transcribeAudioIfNeeded(params.prompt, groqApiKey);
// then use transcribedPrompt instead of params.prompt
```

## Configuration

New env var: `CTI_GROQ_API_KEY`

- Added to `config.env.example`
- Read in `src/config.ts` and passed through to `llm-provider.ts`
- If absent: voice files fall through unchanged, warning logged once at startup

## Error Handling

- Groq API error → log warning, keep original file path in prompt (graceful degradation)
- File not found on disk → log warning, skip transcription for that path
- Network timeout → same as API error

## Supported Formats

`.ogg` (Discord voice), `.mp3`, `.mp4`, `.wav`, `.m4a`, `.webm`, `.flac`, `.oga`

## Non-Goals

- Video transcription
- Real-time streaming transcription
- Local/offline Whisper model support
- Telegram/Feishu-specific handling (works automatically via same upload path)
