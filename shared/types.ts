/**
 * Wire contracts shared by the browser app and the Node server.
 * Keep this file dependency-free so both tsconfigs can consume it.
 */

export interface BBox {
  /** Normalized 0..1, relative to the analysed image (x = left, y = top). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TargetAttribute {
  key: string;
  value: string;
  /** How useful this attribute is to recognise the object in a new scene. */
  distinctiveness: 'high' | 'medium' | 'low';
}

/** What the AI understood about the uploaded reference photo. */
export interface TargetProfile {
  /** Human readable target name, e.g. "blue ceramic coffee mug". */
  name: string;
  category: string;
  attributes: TargetAttribute[];
  distinguishingColors: string[];
  /** Box of the target inside the *reference photo* — used to cut anchor templates. */
  targetBBox: BBox | null;
  /** 8-14 short visual descriptors used by the local matcher (embeddings/anchors). */
  descriptors: string[];
  /** How the user should sweep the room with the camera. */
  sceneGuidance: string;
  /** A very short line the agent says while searching. */
  searchHint: string;
  ambiguityRisks: string[];
}

/** Per-frame detection observation from the model (normalized box, never guessed). */
export interface DetectionObs {
  visible: boolean;
  /** 0..1 — model's own confidence that the target is visible in this frame. */
  confidence: number;
  bbox: BBox | null;
  reason?: string;
  attributes?: string[];
  /** How many look-alike objects it considered. */
  candidatesConsidered?: number;
}

export interface VerifyResult {
  visible: boolean;
  confidence: number;
  reason?: string;
}

export interface AnalyzeResponse {
  profile: TargetProfile;
  warnings: string[];
  model: string;
  latencyMs: number;
}

export interface DetectResponse extends DetectionObs {
  model: string;
  latencyMs: number;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  methods: string[];
  inputTokenLimit?: number;
  thinking?: boolean;
}

export interface VerifyModelsResponse {
  models: ModelInfo[];
  recommended: string[];
}

export interface CapabilityCheckResponse {
  capability: string;
  ok: boolean;
  note: string;
  model: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** What the user should do next. */
    hint?: string;
    upstreamStatus?: number;
  };
}

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
