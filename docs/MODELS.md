# Model verification — what this app assumes about Gemini

Verified against a live key with:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$KEY" | python -m json.tool
```

## What the app needs

| Capability | Endpoint | Requirement |
| --- | --- | --- |
| Reference understanding | `generateContent` | **image input** + JSON response schema |
| Per-frame localisation | `generateContent` | image input, low temperature, tolerates ~1 call/s |
| Candidate verification | `generateContent` | **two images** in one request (reference + crop) |
| Voice + live video | Bidi `BidiGenerateContent` (Live API) | 16 kHz PCM16 audio in, 24 kHz out, JPEG video frames |

## Selection policy

1. **Text/vision model** — the curated list is Flash-class only:
   `gemini-flash-latest`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`,
   `gemini-flash-lite-latest`. These are documented as multimodal, cheap enough for
   ~1 frame/s, and the ones that actually work on free-tier keys.
2. **Pro / newest flagship models** (`gemini-2.5-pro`, `gemini-3.x-pro/flash`,
   `gemini-3.8-*`, …) are intentionally **not** the default — they were reported as
   failing / quota-blocked on this account's tier. The Settings screen still lets you
   type any model id, and **Verify key & list models** calls
   `GET /v1beta/models` with *your* key and reports which candidates exist, switching
   automatically if your current pick is unavailable.
3. **TTS/embedding/image-generation models** in the `models` list are irrelevant here —
   the app never assumes any of them.
4. **Live model** — `LIVE_MODEL_CANDIDATES` is probed in order
   (`gemini-2.5-flash-live`, `gemini-2.5-flash-native-audio-latest`,
   `gemini-live-2.5-flash-preview`, `gemini-2.0-flash-live-001`). Success is only
   reported when the upstream answers `setupComplete`. Model-support claims come from
   an actual handshake, not from hope.

## Fallback matrix (honest degradation, no fake demos)

| Situation | Behaviour |
| --- | --- |
| Key invalid | Typed error (`INVALID_KEY`) at every entry point; Live probe stops immediately (no retry storm); push-to-talk + typed chat remain available. |
| Key valid, Live model unsupported | Socket close reason is mapped (`MODEL_UNSUPPORTED`) and shown; the app switches to push-to-talk: browser STT → `/api/chat` (with the current camera frame attached) → browser TTS. UI labels the mode. |
| `generateContent` without image support | `/api/capability` reports it; the user is told to pick a multimodal Flash model. |
| Quota exhausted (429) | `RATE_LIMITED` with a hint to lower the detection rate; the local tracker keeps running so the UI degrades gracefully. |
| Model returns no coordinates | Presence is recorded, box is **not** drawn, and an observation says "position unclear". |

## Live API session shape (as implemented)

```jsonc
// upstream setup the server sends (through /api/live proxy)
{
  "setup": {
    "model": "models/gemini-2.5-flash-live",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Aoede" } } }
    },
    "systemInstruction": { "parts": [{ "text": "<server-owned prompt>" }] },
    "inputAudioTranscription": {},
    "outputAudioTranscription": {},
    "realtimeInputConfig": { "automaticActivityDetection": { "disabled": false } }
  }
}
// then, per media chunk
{ "realtimeInput": { "mediaChunks": [{ "mimeType": "audio/pcm;rate=16000", "data": "<b64>" }] } }
{ "realtimeInput": { "mediaChunks": [{ "mimeType": "image/jpeg", "data": "<b64 jpeg>" }] } }
```

The live model also emits a compact JSON status line per frame
(`{"visible":…,"confidence":…,"reason":…,"guide":…}`). The client parses it, speaks only
the conversational part, and forwards `visible/confidence` to the vision engine as
**presence evidence** — never as coordinates.

If Google changes an accepted field name, the failure surfaces as a normal
`INVALID_ARGUMENT`/close reason with the upstream text preserved in the UI, and voice
falls back to push-to-talk. The audio path can therefore be re-pointed at another
realtime provider without touching the vision pipeline.
