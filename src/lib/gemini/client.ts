import type {
  AnalyzeResponse,
  CapabilityCheckResponse,
  DetectResponse,
  TargetProfile,
  VerifyModelsResponse,
  VerifyResult,
} from '../contracts';
import { postJson } from './transport';
import type { CapturedJpeg } from '../vision/frames';
import type { BBox } from '../contracts';

/**
 * Domain-level API. UI code talks to this module only — prompts and model
 * details stay on the server (see server/prompts.ts).
 */

export interface InlineImagePayload {
  data: string;
  mimeType: string;
}

export interface HealthInfo {
  ok: boolean;
  service: string;
  mode: string;
  byok: boolean;
  serverKeyAvailable: boolean;
  defaultModel: string;
  curatedModels: { id: string; label: string; note: string }[];
}

function asPayload(image: CapturedJpeg | InlineImagePayload): InlineImagePayload {
  return 'base64' in image ? { data: image.base64, mimeType: image.mimeType } : image;
}

export const geminiApi = {
  health: () => fetch('/api/health').then((r) => r.json() as Promise<HealthInfo>),

  /** Verifies the key and returns which curated models actually exist for it. */
  models: (apiKey: string) => postJson<VerifyModelsResponse>('/api/models', { apiKey }),

  analyze: (apiKey: string, model: string, image: InlineImagePayload) =>
    postJson<AnalyzeResponse>('/api/analyze', { apiKey, model, image }),

  detect: (apiKey: string, model: string, image: CapturedJpeg, profile: TargetProfile | null, history: string[] = []) =>
    postJson<DetectResponse>('/api/detect', {
      apiKey,
      model,
      image: asPayload(image),
      profile,
      history,
    }),

  verify: (
    apiKey: string,
    model: string,
    reference: InlineImagePayload,
    crop: CapturedJpeg | InlineImagePayload,
    profile: TargetProfile | null,
  ) => postJson<VerifyResult>('/api/verify', { apiKey, model, reference, crop: asPayload(crop), profile }),

  capability: (apiKey: string, model: string, image?: InlineImagePayload) =>
    postJson<CapabilityCheckResponse>('/api/capability', { apiKey, model, image }),

  chat: (
    apiKey: string,
    model: string,
    messages: { role: 'user' | 'model'; text: string }[],
    options: { image?: CapturedJpeg | null; system?: string } = {},
  ) =>
    postJson<{ text: string; model: string; latencyMs: number }>('/api/chat', {
      apiKey,
      model,
      messages,
      image: options.image ? asPayload(options.image) : null,
      system: options.system ?? '',
    }),

  /** Only works when the operator configured GEMINI_API_KEY on the server. */
  serverKey: () => postJson<{ apiKey: string }>('/api/server-key', {}),

  /** Server-owned system instructions for the voice + video agent. */
  liveInstruction: (profile: TargetProfile | null, voiceStyle: 'calm' | 'energetic' | 'minimal') =>
    postJson<{ instruction: string; scenePrompt: string }>('/api/live-instruction', { profile, voiceStyle }),
};

export type { BBox };
