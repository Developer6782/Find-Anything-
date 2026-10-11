# Find Anything — AI Visual Search Agent

**“Find Anything. Just Look Around.”**
Upload a photo of an object → sweep the room with your camera → the agent talks
you through the search and outlines the object the moment it appears.

A working visual-search pipeline, not a mockup:

- **Reference understanding** — Gemini builds a target profile (attributes, colours,
  confusable look-alikes, a tight template box) from the uploaded photo.
- **Per-frame localisation** — Gemini localises the target in downscaled live frames;
  an **on-device ZNCC template tracker (10 fps)** keeps the box glued to the object
  between model calls and snaps it onto real pixels.
- **Two-way voice** — a real **Gemini Live API** session (audio in/out + streamed video)
  guides the user. If the user's key/tier cannot use Live, the app says so and falls
  back to **push-to-talk (browser STT + Gemini multimodal + TTS)** — it never fakes a
  live session.
- **Honest states** — `searching → acquiring → locked → temporarily lost → lost`,
  with confidence, evidence source and last-seen time on screen.

---

## 1. Quick start

```bash
npm install
npm run dev            # http://localhost:5180  (Vite HMR behind an Express API server)
```

1. Open the app → **Start Visual Search**.
2. Paste your own **Gemini API key** (BYOK — see §4). Get one at
   <https://aistudio.google.com/apikey>.
3. Upload a reference photo → the agent analyses it.
4. Press **Start visual search**, allow camera + microphone, and move slowly.
5. `M` mic · `C` camera · `R` re-scan · `Space` pause/resume.

Production build:

```bash
npm run build          # typecheck + build server + build SPA
npm start              # single Express process serving dist/ + /api on PORT (default 5180)
```

Deploy notes: one Node process, one port, `0.0.0.0`. **HTTPS is mandatory** for
camera/microphone in any real browser (localhost is the only exception), so put it
behind any TLS proxy/tunnel. No build-time env vars are required for BYOK.

---

## 2. Architecture

```
browser                                    node (one process, one origin)
┌───────────────────────────────┐          ┌──────────────────────────────────────┐
│ Landing / Dashboard (React)   │          │ Express                              │
│  ├ useSettings   (BYOK vault) │  fetch   │  ├ POST /api/models       (key check) │
│  ├ useCamera     (getUserMedia│ ───────► │  ├ POST /api/analyze      (profile)   │
│  ├ useSearchSession (orchestr)│  /api/*  │  ├ POST /api/detect       (per frame) │
│  │   ├ VisionEngine           │          │  ├ POST /api/verify       (crop check)│
│  │   │   ├ ObjectTracker ZNCC │          │  ├ POST /api/chat         (PTT fallback)
│  │   │   └ FrameGrabber       │          │  ├ POST /api/capability   (self-test) │
│  │   ├ LiveSession  (voice)   │   ws     │  ├ POST /api/live-instruction         │
│  │   ├ PushToTalk  (fallback) │ ◄──────► │  └ ws   /api/live  → Gemini Live API  │
│  │   └ AudioPlayer / Speaker  │  /api/live│     (key forwarded, never stored)    │
│  └ BoxOverlay (normalized→px) │          │  prompts.ts · gemini.ts · errors.ts   │
└───────────────────────────────┘          └──────────────────────────────────────┘
```

**Separation of concerns**

| Layer | Files | Responsibility |
| --- | --- | --- |
| UI | `src/components/**` | Rendering, layout, accessibility, responsiveness |
| Orchestration | `src/state/**` | Session lifecycle, resource ownership, conversation |
| Vision engine | `src/lib/vision/**` | Frame grabbing, ZNCC matching, tracking states, fusion |
| Media/audio | `src/lib/media`, `src/lib/audio` | Camera, mic PCM16, playback, Live session, PTT |
| API boundary | `src/lib/gemini/**` | Typed HTTP client (never talks to Google directly) |
| Server | `server/**` | Key custody, prompts, schemas, error mapping, Live proxy |
| Contracts | `shared/types.ts` | Wire types shared by both sides |

Nothing about a prompt, model or coordinate format lives in the UI, and no API key
is ever placed in a URL (they leak into logs/history/proxies) — the client sends the
key in a JSON body / first websocket frame; the server forwards it in an
`x-goog-api-key` header.

---

## 3. The vision pipeline (how the box gets accurate)

A text model's coordinates are approximate and jitter frame-to-frame. So the
pipeline is deliberately **hybrid**:

1. **Reference → template.** `/api/analyze` returns a normalized `targetBBox` (tight
   box of the object in the photo) plus descriptors. The app cuts **two anchor
   templates** (whole object + inner "core" patch) from the reference photo.
2. **Model prior.** `/api/detect` gets one downscaled frame (640 px, ~1.2 fps by
   default) and returns `{visible, confidence, bbox}` — `bbox` is optional and the
   prompt forbids inventing one. Boxes may be sent as `{x,y,width,height}` or as
   `[ymin,xmin,ymax,xmax]`, all normalised by the server (`sanitizeBBox`), with
   degenerate/absurd boxes rejected outright.
3. **On-device tracking.** Every frame (~10 fps, 192 px working copy) the ZNCC
   tracker searches a region around the last box (plus a throttled full-frame sweep).
   ZNCC is illumination invariant, which is why the same mug matches on a dark desk
   and a bright shelf. The match **overrides the box position while the model keeps
   saying "visible"**, giving sub-frame stability at no API cost.
4. **De-drifting.** A weak ROI match is always cross-checked against the global
   sweep — the failure mode of naive template trackers ("the box slowly slides onto
   the wrong thing") is exactly what this prevents.
5. **Verification.** `/api/verify` compares the **reference photo** against the
   candidate **crop** with a strict judge prompt ("same object, not same category").
   Two consecutive rejections demote the lock and restart the search.
6. **Fusion & states.** Evidence (model confidence × time decay, verifier verdict,
   local ZNCC) is fused into one confidence. States: `locked` (box solid),
   `acquiring` (dashed + "confirming…"), `occluded` ("Temporarily lost", box dimmed,
   last-known position held, age shown), `lost` (box hidden, agent re-guides).
   A mid-confidence jump to an unrelated region is ignored rather than obeyed.
7. **Screen mapping.** Boxes are normalized 0..1 in the **analysed frame's** space and
   mapped to pixels inside the letterboxed `object-fit: contain` rect measured by a
   `ResizeObserver`. Verified on desktop/tablet/mobile viewports by the automated
   E2E test (§6) — deltas < 1 px. Front-camera previews are mirrored together with
   the box so alignment stays correct.

Optional live-frame signals from the voice model (a JSON status line it is instructed
to emit per frame) are treated as **presence evidence only**: they can confirm or
deny visibility, but they can never move or invent the box.

---

## 4. BYOK — key handling

- The key is entered in **Settings**, never hardcoded, never bundled, never logged.
- Storage modes (explicit, user-chosen):
  - **This tab only** (default) — `sessionStorage`, cleared when the tab closes.
  - **Encrypted on this device** — AES-GCM, key derived with PBKDF2-SHA256
    (210 000 iterations, random salt + IV per save) before anything touches
    `localStorage`. Requires the passphrase once per page load.
  - **Never stored** — memory only.
- No mode ever writes the raw key to `localStorage`; the plaintext key lives only in
  a module-level variable for the session.
- The server holds the key in memory for the lifetime of a request/socket only.
- Optional `GEMINI_API_KEY` on the server enables a "Use server key (demo)" button;
  with it unset the app is 100 % BYOK.

## 5. Model choice

Verified against a live key with `GET /v1beta/models` (see `docs/MODELS.md`):

- The app defaults to **Flash-class** models (`gemini-flash-latest`,
  `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-flash-lite-latest`) — these
  support `generateContent` **with image input** and behave on the free tier.
- Pro/newest flagship models were reported failing on this account's tier, so they are
  **not** offered by default; the settings screen has a "Verify key & list models"
  action that shows what *your* key can actually use, and adapts.
- **Live voice** probes candidate Live models in order and only reports success when
  a real `setupComplete` arrives. Invalid key / unsupported model is shown verbatim
  and voice degrades to push-to-talk. No fake "listening" state exists anywhere.

## 6. Testing

```bash
npm test              # 52 unit tests: geometry/mapping, ZNCC, tracker, engine, vault, coord parsing
npm run build         # typecheck (client + server) + production build
npm run e2e           # browser E2E smoke (needs: npm i -D playwright && npx playwright install chromium)
```

The E2E smoke test drives the real UI in Chromium with a **synthetic camera** and
**stubbed Gemini endpoints**, and asserts:

- landing → dashboard, BYOK connect flow, analysis chips rendering;
- live session locks on and draws a box;
- **box alignment on desktop 1440×900, tablet 1024×768 and mobile 390×844**
  (measured against an independently computed expected rectangle);
- occlusion degrades the state honestly instead of showing a stale box;
- `last seen` shows a sane timestamp;
- ending the session releases camera tracks and resets the UI;
- zero page errors.

See `docs/TESTING.md` for the manual device matrix (lighting, object types,
wrong-target, degraded network) and the exact commands.

## 7. Cost & performance controls

| Control | Default | Where |
| --- | --- | --- |
| Model localisations | 1.2 / s | Settings → Detection rate |
| Local tracker | 10 / s, free | `DETECTION.localFps` |
| Detection frame size | 640 px wide, JPEG q0.72 | `DETECTION.frameWidth` |
| Live video frames | 1 / 1.2 s, 512 px | `LIVE.frameIntervalMs` |
| Frames while speaking | paused | `LIVE.avoidWhileSpeakingMs` |
| Cross-check verifier | on | Settings → verify toggle |
| Live session cap | 30 min | `LIVE.maxSessionMinutes` |

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Camera requires a secure context" | Open over HTTPS or `localhost`. |
| Permission denied | Address-bar camera icon → Allow. iOS: Settings → Safari → Camera. |
| Mic not captured | Same permission path; check no other app holds the mic. |
| `INVALID_KEY` | Retype the key (no spaces) or create a fresh one in AI Studio. |
| `RATE_LIMITED` | Lower **Detection rate**, wait a minute, or use another key. |
| `MODEL_UNSUPPORTED` / Live fails | Run **Verify key & list models**; voice falls back to push-to-talk. |
| Box looks stuck on a look-alike | Toggle "cross-check candidates" on; two verifier rejections demote a wrong lock. |
| Nothing is detected | More light, move slower, keep the object 30–70 % of the frame. |

## 9. Repo map

```
server/            Express API + Live websocket proxy + prompts/schemas/errors
shared/types.ts    wire contracts (both sides)
src/components/    landing, dashboard, panels, settings (design system in ui/primitives)
src/state/         useSettings (BYOK), useCamera, useSearchSession (orchestrator)
src/lib/vision/    bbox math, image ops, matcher (ZNCC), tracker, engine (fusion/state)
src/lib/gemini/    typed client + transport
src/lib/audio/     mic PCM16, player, LiveSession, push-to-talk
src/lib/media/     camera helpers
src/tests/         vitest suites
scripts/           e2e-smoke.cjs (Playwright, optional)
docs/              TESTING.md, ARCHITECTURE.md, MODELS.md, screenshots/
```

## 10. Honest limitations

- Gemini gives *approximate* localisation; on-device ZNCC supplies the pixel accuracy.
  Objects with **no visual texture** (plain white mug, blank box) match weakly — the UI
  tells you when the reference photo is unsuitable.
- Re-acquisition after a fast pan relies on the throttled global sweep; it costs a few
  hundred milliseconds, during which the state honestly reads "temporarily lost".
- The Live API's support varies by key/tier; the probe + fallback path is the only
  supported behaviour (no simulated live sessions).
- Landing-page hero animation is a **labelled preview**, never presented as detection.
