import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { GeminiApiError } from './errors.js';
import {
  CURATED_MODELS,
  DEFAULT_TEXT_MODEL,
  analyzeReference,
  capabilityCheck,
  detectInFrame,
  listModels,
  verifyCandidate,
  type InlineImage,
} from './gemini.js';
import { attachLiveProxy } from './liveProxy.js';
import { liveScenePrompt, liveSystemInstruction } from './prompts.js';
import type { TargetProfile } from '../shared/types.js';

const PORT = Number(process.env.PORT ?? 5180);
const IS_PROD = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
const SERVER_KEY = process.env.GEMINI_API_KEY?.trim() || null;
const MAX_INLINE_BYTES = 6 * 1024 * 1024; // ~6 MB of base64 per image

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use((_req, res, next) => {
  res.setHeader('cache-control', 'no-store');
  next();
});

/* ─────────────────────────────── helpers ────────────────────────────────── */

function readKey(req: Request): string {
  const key = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!key) throw new GeminiApiError('NO_KEY', 'No Gemini API key was provided.');
  if (key.length > 400 || /\s/.test(key)) {
    throw new GeminiApiError('INVALID_KEY', 'That does not look like a valid API key.');
  }
  return key;
}

function readModel(req: Request): string {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  return model || DEFAULT_TEXT_MODEL;
}

function readImage(value: unknown, field: string): InlineImage {
  const img = value as { data?: unknown; mimeType?: unknown } | undefined;
  if (!img || typeof img.data !== 'string' || !img.data) {
    throw new GeminiApiError('NO_IMAGE', `Missing image payload (${field}).`);
  }
  if (img.data.length > MAX_INLINE_BYTES) {
    throw new GeminiApiError('BAD_REQUEST', `Image too large (${field}). Use a frame under ~4 MB.`);
  }
  const mimeType = typeof img.mimeType === 'string' ? img.mimeType : 'image/jpeg';
  if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) {
    throw new GeminiApiError('BAD_REQUEST', `Unsupported image type: ${mimeType}`);
  }
  return { data: img.data, mimeType };
}

function health(_req: Request, res: Response) {
  res.json({
    ok: true,
    service: 'find-anything',
    mode: IS_PROD ? 'production' : 'development',
    byok: true,
    serverKeyAvailable: Boolean(SERVER_KEY),
    defaultModel: DEFAULT_TEXT_MODEL,
    curatedModels: CURATED_MODELS,
    time: new Date().toISOString(),
  });
}

/* ──────────────────────────────── routes ────────────────────────────────── */

app.get('/api/health', health);

/** List the key's real models and which of the curated ones exist for it. */
app.post('/api/models', async (req, res, next) => {
  try {
    const key = readKey(req);
    res.json(await listModels(key));
  } catch (err) {
    next(err);
  }
});

/**
 * Optional convenience for demos: exposes the server-side key ONLY if the
 * operator put one in the environment. Never logs it, never stores it.
 */
app.post('/api/server-key', (_req, res) => {
  if (!SERVER_KEY) {
    res.status(404).json({ error: { code: 'NO_KEY', message: 'No server-side key is configured.' } });
    return;
  }
  res.json({ apiKey: SERVER_KEY });
});

/**
 * System instruction for the voice/video agent. Kept server-side so prompts
 * live in one place; the client fetches it once per session.
 */
app.post('/api/live-instruction', (req, res, next) => {
  try {
    const profile = (req.body?.profile ?? null) as TargetProfile | null;
    const voiceStyle = req.body?.voiceStyle === 'energetic' || req.body?.voiceStyle === 'minimal'
      ? req.body.voiceStyle
      : 'calm';
    res.json({
      instruction: liveSystemInstruction({ profile, voiceStyle }),
      scenePrompt: liveScenePrompt(profile),
    });
  } catch (err) {
    next(err);
  }
});

/** Step 3 of the flow: understand the uploaded reference photo. */
app.post('/api/analyze', async (req, res, next) => {
  try {
    const key = readKey(req);
    const model = readModel(req);
    const image = readImage(req.body?.image, 'image');
    res.json(await analyzeReference(key, model, image));
  } catch (err) {
    next(err);
  }
});

/** Step 6/7: localise the target inside one live frame. */
app.post('/api/detect', async (req, res, next) => {
  try {
    const key = readKey(req);
    const model = readModel(req);
    const image = readImage(req.body?.image, 'image');
    const profile = (req.body?.profile ?? null) as TargetProfile | null;
    const history = Array.isArray(req.body?.history) ? (req.body.history as string[]).slice(-8) : [];
    res.json(await detectInFrame(key, model, image, profile, history));
  } catch (err) {
    next(err);
  }
});

/** High-precision confirmation of a candidate crop against the reference. */
app.post('/api/verify', async (req, res, next) => {
  try {
    const key = readKey(req);
    const model = readModel(req);
    const reference = readImage(req.body?.reference, 'reference');
    const crop = readImage(req.body?.crop, 'crop');
    const profile = (req.body?.profile ?? null) as TargetProfile | null;
    res.json(await verifyCandidate(key, model, reference, crop, profile));
  } catch (err) {
    next(err);
  }
});

/** Ability self-test used by Settings → "Test capabilities". */
app.post('/api/capability', async (req, res, next) => {
  try {
    const key = readKey(req);
    const model = readModel(req);
    const image = req.body?.image ? readImage(req.body.image, 'image') : null;
    if (!image) {
      // No image supplied: fall back to a text-only probe.
      const models = await listModels(key);
      const found = models.models.some((m) => m.id === model);
      res.json({
        capability: 'model.available',
        ok: found,
        note: found ? `${model} is available for this key.` : `${model} is NOT listed for this key.`,
        model,
      });
      return;
    }
    res.json(await capabilityCheck(key, model, image));
  } catch (err) {
    next(err);
  }
});

/**
 * Text chat turn (used by typed input and by push-to-talk voice fallback when
 * the Live API is unavailable). Optionally attaches one live frame.
 */
app.post('/api/chat', async (req, res, next) => {
  try {
    const key = readKey(req);
    const model = readModel(req);
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const image = req.body?.image ? readImage(req.body.image, 'image') : null;
    const system = typeof req.body?.system === 'string' ? req.body.system.slice(0, 8000) : '';

    const contents = messages.slice(-14).map((m: any) => ({
      role: m?.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m?.text ?? '').slice(0, 4000) }],
    }));
    if (image && contents.length) {
      const last = contents[contents.length - 1];
      last.parts = [...last.parts, { inlineData: { data: image.data, mimeType: image.mimeType } }] as any;
    }
    if (!contents.length) {
      contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { temperature: 0.6, maxOutputTokens: 320 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const started = Date.now();
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      },
    );
    const json: any = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const { mapUpstreamError } = await import('./errors.js');
      throw mapUpstreamError(upstream.status, json);
    }
    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter((p: any) => typeof p?.text === 'string' && p.thought !== true)
      .map((p: any) => p.text)
      .join(' ')
      .trim();
    res.json({ text: text || 'I did not catch that — say it again?', model, latencyMs: Date.now() - started });
  } catch (err) {
    next(err);
  }
});

// Central error handler → typed, user-friendly payloads.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof GeminiApiError) {
    const status =
      err.code === 'NO_KEY' || err.code === 'NO_IMAGE'
        ? 400
        : err.code === 'INVALID_KEY'
          ? 401
          : err.code === 'RATE_LIMITED'
            ? 429
            : 502;
    res.status(status).json(err.toBody());
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[find-anything] unhandled error:', err);
  res.status(500).json({
    error: { code: 'UNKNOWN', message: 'Unexpected server error.', hint: 'Check the server logs and retry.' },
  });
});

/* ───────────────────────── static / dev middleware ──────────────────────── */

const server = http.createServer(app);
attachLiveProxy(server);

const distDir = path.resolve(process.cwd(), 'dist');

async function start() {
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, host: true, allowedHosts: true, cors: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('[find-anything] Vite dev middleware attached (HMR on).');
  } else {
    if (!fs.existsSync(distDir)) {
      console.error('[find-anything] dist/ not found. Run `npm run build` first (or start without --prod).');
      process.exit(1);
    }
    app.use(express.static(distDir, { index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
    console.log('[find-anything] serving production build from dist/.');
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[find-anything] ready on http://0.0.0.0:${PORT}`);
    console.log(`[find-anything] BYOK: ${SERVER_KEY ? 'server key also available for demos' : 'user key only'}`);
  });
}

start().catch((err) => {
  console.error('[find-anything] failed to start:', err);
  process.exit(1);
});
