# Testing — Find Anything

Three layers: **unit tests** (pure logic), **browser E2E smoke** (real UI + synthetic
camera), and a **manual device matrix** (things only a human with a real room can do).

---

## 1. Unit tests — `npm test`

52 tests, no network, no browser. Files:

| Suite | What it locks down |
| --- | --- |
| `src/tests/bbox.test.ts` | Normalized geometry: clamp, IoU, expand, degenerate-box rejection, crop rects inside bounds, and **screen mapping across viewports** (letterbox 640×480→400×400, pillarbox 480×640→800×400, exact fill, portrait 360×640, fractional DPR sizes). |
| `src/tests/matcher.test.ts` | ZNCC correctness: exact localisation, **illumination invariance** (0.55× brightness scene still matches), unrelated noise scores low, flat patches rejected, multi-scale search, ROI helper, and the tracker's ROI/global/re-acquire/refine paths. |
| `src/tests/engine.test.ts` | State machine on a **manual clock**: lock on confident hit, never invent a box when the model claims presence without coordinates, ignore low-confidence guesses, `locked → occluded → lost → re-acquired`, suspicious-jump rejection, pause/resume, live-model presence without position, observation logging. |
| `src/tests/keyVault.test.ts` | BYOK storage: memory/session/encrypted modes, **no plaintext key in localStorage**, AES-GCM envelope shape, wrong passphrase → typed error, short passphrase rejected, mode switching cleans stale blobs, hint is non-revealing. |
| `src/tests/coords.test.ts` | Untrusted model output: `[ymin,xmin,ymax,xmax]` 0–1000 form, 0–1 arrays, `xmin/xmax` naming, clamping, and rejection of degenerate boxes; plus `parseStatusLine` for the Live model's status JSON. |

Run: `npm test` · watch: `npm run test:watch`

## 2. Browser E2E smoke — `npm run e2e`

```bash
npm install -D playwright && npx playwright install chromium   # one-time
npm run dev                                                    # in another terminal
npm run e2e
```

What it does (see `scripts/e2e-smoke.cjs`): launches Chromium with a **synthetic
camera** (`--use-fake-device-for-media-stream`) and stubs the Gemini endpoints with
`page.route`, so it is deterministic and consumes no quota. The product itself has no
demo/detection-faking path — this is test tooling only.

Asserts:

1. Landing → dashboard; settings auto-opens when no key exists; connecting a key in
   "This tab only" mode updates the header chip and clears the warning.
2. Upload → analysis → target profile chips render.
3. Start session → camera delivers frames → engine reaches `locked`.
4. **Box alignment** on 1440×900, 1024×768 and 390×844: the drawn box is compared
   against an independently computed rectangle (object-fit mapping + overlay padding).
5. `last seen` shows a plausible timestamp (guards the monotonic-vs-wall-clock bug).
6. Occlusion (`visible:false` stub) → state degrades, box does not linger as if fresh.
7. End session → camera tracks released (`video.srcObject === null`), summary shown.
8. Zero page errors.

Latest run (this repo):

```
[desktop-1440x900] state=locked conf=0.90 ALIGNMENT OK (Δ -0.1, -0.0, 0.4, -0.0) | stable: true
[tablet-1024x768]  state=locked conf=0.90 ALIGNMENT OK (Δ -0.1, -0.0, 0.4, -0.0) | stable: true
[mobile-390x844]   state=locked conf=0.90 ALIGNMENT OK (Δ -0.0, -0.0, -0.0, -0.0) | stable: true
occlusion: state=occluded conf=0.07 box=held at last known position
session end: camera tracks released: true | session summary shown: true
E2E SMOKE: PASS
```

Screenshots land in `docs/screenshots/` (including `box-alignment-*.png`).

## 3. Manual device matrix

Do these with a real camera and a real key — automated tests cannot judge taste,
lighting or a genuinely occluded mug.

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | Matte object with texture (book, mug with logo, shoe) in even light | Lock within ~1–3 s of the object entering the frame; box hugs the object. |
| 2 | Low light | Confidence lower, more "position unclear" observations, no invented boxes. |
| 3 | Backlit / window glare | Verifier rejects look-alikes; state may stay `acquiring`. |
| 4 | Similar objects nearby (two identical bottles) | `candidatesConsidered` rises; verifier picks the reference match; other bottle is not boxed. |
| 5 | Wrong target (search "red bottle" while holding a blue one) | Never `locked`; agent keeps guiding, eventually "lost". |
| 6 | Ambiguous scene (empty wall) | Honest `searching` → observations say "not visible". |
| 7 | Cover the object with your hand | `locked` → `temporarily lost` (box dimmed, age shown) → uncover → `re-acquired`. |
| 8 | Fast 180° pan | Box does not teleport onto a look-alike; state goes lost rather than wrong. |
| 9 | Front camera | Box mirrors with the preview and stays aligned. |
| 10 | Mobile portrait + landscape rotate mid-session | Overlay re-measures; alignment preserved. |
| 11 | Airplane mode mid-session | Detection errors surface as observations; local tracker keeps the last box dimmed; no crash. |
| 12 | Invalid API key | Typed error with hint; nothing else breaks. |
| 13 | Voice: Live API unavailable for key | Clear notice, push-to-talk works (STT → Gemini with current frame → TTS). |
| 14 | Grant camera, deny mic | Session continues, mic button shows the error, typed chat works. |
| 15 | End session | Camera LED off, mic released, summary + downloadable JSON log. |
| 16 | Keyboard only | Tab reaches every control, visible focus rings, `M/C/R/Space` work. |

Record pass/fail per row; attach the session JSON log (End session → *Download log*)
for any failure — it contains observations, states and timings.

## 4. Quality gates used in this repo

```bash
npm test          # unit
npm run build     # tsc client + tsc server + vite build (must be clean)
npm run e2e       # browser smoke (must print E2E SMOKE: PASS)
```

All three pass on the current commit; the production bundle is 84 kB gzipped JS +
7 kB gzipped CSS and contains no debug hooks (the QA bridge in `useSearchSession` is
compiled out of production builds via `import.meta.env.DEV`).
