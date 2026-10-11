# Architecture & decision log

## 1. Runtime topology

Single Node process (Express) serving **one origin**: the API, the Live websocket
proxy, and the Vite-built SPA (or Vite middleware in dev). One origin means no CORS,
no key in URLs, and a preview/tunnel host works without extra config.

```
┌─ browser ──────────────────────────────────────────────────────────────────┐
│ Landing ──► Dashboard                                                       │
│   reference panel        camera stage (video + BoxOverlay)     agent panel  │
│        │                        │                                  │        │
│        └────► useSearchSession (orchestrator, owns lifecycles) ◄────┘        │
│                     │            │             │                            │
│              VisionEngine    LiveSession    PushToTalk/Speaker              │
│              (rAF loop)      (ws /api/live) (fallback voice)                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2. Frame path (per animation frame)

```
video element ──► FrameGrabber ──┬─► 192 px gray ─► ObjectTracker (ZNCC)  ~2-4 ms
                                 │        └─ ROI around last box, global sweep ≤4/s
                                 └─► 640 px JPEG ─► /api/detect   (throttled: 1.2 fps)
                                                      └─► Gemini multimodal
fusion: model conf (time-decayed) + verifier verdict + local ZNCC  ──► state machine
                                                             └────► BoxOverlay (px)
```

Cost control is structural: the expensive path is rate-limited and downscaled, the
free path runs at video cadence. While the voice model is speaking, live video frames
are suppressed for 900 ms so speech and vision don't fight for the same session.

## 3. Decision log

| Decision | Why | Alternative rejected |
| --- | --- | --- |
| **Hybrid localisation** (Gemini prior + on-device ZNCC) | Text-model boxes jitter and are not pixel-exact; ZNCC is illumination-invariant, runs free at 10 fps, and is stable between model calls. | Prompting a model for coordinates every frame → jitter, cost, drift. |
| **Normalized 0..1 boxes everywhere**, converted once at the edge | Frame size, crop size and screen size become independent; the server normalises `[ymin,xmin,ymax,xmax]` 0–1000, 0–1 arrays and `xmin/xmax` naming. | Pixel coordinates → aspect-ratio bugs and unreproducible "it's off by 40 px on my phone". |
| **Server-side prompts + schemas** | One place to reason about instructions; response schemas force valid JSON; contracts are shared types. | Prompts in components → drift and leaking UI concerns into the model. |
| **BYOK with passphrase-encrypted option + tab-only default** | Users own the key; nothing secret in the bundle; the default avoids plaintext on disk while staying frictionless. | Hardcoded key (disqualifying), or plaintext localStorage (explicitly forbidden). |
| **Live API probed, not assumed** | Capability varies per key/tier. Only a real `setupComplete` counts. | Showing a fake "listening…" state — dishonest and unusable. |
| **Push-to-talk fallback** | Keeps voice *useful* when Live is unavailable: browser STT → `/api/chat` (frame attached) → TTS. | Dropping voice entirely, or simulating it. |
| **No demo mode for detection** | The brief explicitly forbids presenting demo data as detection. The landing hero is labelled "interactive preview"; the E2E test stubs live only inside the test process. | A "demo" toggle that fakes boxes — would undermine the whole product. |
| **Engine injectable clock/frame source** | Lets the state machine be unit-tested deterministically (`now`, `frames` seams) with zero test-only code in the production path. | Sleeping on real timers → flaky tests. |
| **StrictMode intentionally off** | The app owns camera/mic/websocket lifecycles; double-mount in dev tears them down mid-session and produces misleading permission errors. Documented in `src/main.tsx`. | Leaving it on and fighting phantom errors. |

## 4. State machine (vision engine)

```
idle ──setProfile──► searching ──conf≥0.55 + box──► locked
                        ▲                             │  no evidence > 0.9 s
                        │                             ▼
                     reacquire ◄── lost ◄── >3.5 s ── occluded (box dimmed, age shown)
                                                  │   evidence returns
                                                  └──────────► locked (reacquired)
paused ⇄ searching/locked      ended ⇒ resources released
```

Guards that prevent classic failure modes:

- `visible: true` **without** a usable box → "position unclear" observation, box unchanged.
- Confidence below the floor → no box at all (never a guess).
- IoU < 0.05 jump with confidence < 0.8 → ignored (anti-teleport).
- Two verifier rejections → lock demoted, occluded clock started honestly.
- Weak ROI match → always cross-checked against the global sweep (anti-drift).

## 5. Resource ownership

`useSearchSession` is the single owner of: camera stream, mic + AudioWorklet,
`AudioPlayer`, `Speaker`, `LiveSession`, `PushToTalk`, the engine's rAF loop, the
live-frame interval and the session timer. `endSession()` and unmount both release
all of them (tracks stopped, contexts closed, sockets closed). Camera is deliberately
kept alive across **pause** so resume is instant — the pause state is communicated to
the engine, not by tearing hardware down.

## 6. Extension points

| Want to… | Touch |
| --- | --- |
| Swap the realtime voice provider | `src/lib/audio/liveSession.ts` + `server/liveProxy.ts` (keep the auth-frame contract) |
| Replace the local matcher with WebGPU/ORT | implement `track()/refine()` in `src/lib/vision/tracker.ts` |
| Add another detection model | `server/gemini.ts` (same response contract) — the engine only consumes `DetectResponse` |
| Add a real CV detector (e.g. YOLO) alongside | call it inside `VisionEngine.step()` as another evidence source, feed `pushExternal()` |
| Persist sessions | `SessionSummary` already exports the full JSON log |
