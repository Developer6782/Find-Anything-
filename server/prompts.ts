import type { TargetProfile } from '../shared/types.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Prompt + response-schema library.
 *
 * Hard rules encoded everywhere:
 *  - never invent a location; a bounding box is optional and only for confident,
 *    clearly visible hits;
 *  - coordinates are normalized 0..1 relative to the analysed frame;
 *  - "visible": false is a first-class, expected answer (occlusion, motion blur).
 * ──────────────────────────────────────────────────────────────────────────── */

const BBOX_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1, description: 'left edge / image width' },
    y: { type: 'number', minimum: 0, maximum: 1, description: 'top edge / image height' },
    width: { type: 'number', minimum: 0, maximum: 1, description: 'box width / image width' },
    height: { type: 'number', minimum: 0, maximum: 1, description: 'box height / image height' },
  },
  required: ['x', 'y', 'width', 'height'],
} as const;

export const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'short target name, e.g. "blue ceramic coffee mug"' },
    category: { type: 'string' },
    attributes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          distinctiveness: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['key', 'value', 'distinctiveness'],
      },
    },
    distinguishingColors: { type: 'array', items: { type: 'string' } },
    targetBBox: {
      ...BBOX_SCHEMA,
      description: 'tight normalized box (0..1) around the target inside THIS reference photo',
    },
    descriptors: {
      type: 'array',
      items: { type: 'string' },
      description: '10-14 short, visual, camera-observable phrases (colour, material, shape, logos, wear)',
    },
    sceneGuidance: { type: 'string', description: 'one sentence on how to sweep the room with a phone camera' },
    searchHint: { type: 'string', description: 'very short spoken line used while searching' },
    ambiguityRisks: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'name',
    'category',
    'attributes',
    'distinguishingColors',
    'targetBBox',
    'descriptors',
    'sceneGuidance',
    'searchHint',
    'ambiguityRisks',
  ],
  propertyOrdering: [
    'name',
    'category',
    'attributes',
    'distinguishingColors',
    'targetBBox',
    'descriptors',
    'sceneGuidance',
    'searchHint',
    'ambiguityRisks',
  ],
} as const;

export const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    visible: { type: 'boolean', description: 'true ONLY if the exact target is clearly visible in this frame' },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'your certainty; use < 0.5 when you are guessing',
    },
    bbox: BBOX_SCHEMA,
    reason: { type: 'string', description: 'short justification of the decision' },
    attributes: { type: 'array', items: { type: 'string' }, description: 'observed attributes matching the target' },
    candidatesConsidered: { type: 'integer', description: 'number of similar objects you compared' },
  },
  required: ['visible', 'confidence', 'reason'],
  propertyOrdering: ['visible', 'confidence', 'bbox', 'reason', 'attributes', 'candidatesConsidered'],
} as const;

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    visible: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
  required: ['visible', 'confidence', 'reason'],
  propertyOrdering: ['visible', 'confidence', 'reason'],
} as const;

export const CAPABILITY_SCHEMA = {
  type: 'object',
  properties: {
    canReadImage: { type: 'boolean', description: 'true if you can describe the image content' },
    note: { type: 'string', description: 'one short sentence: what you see, or why you cannot' },
  },
  required: ['canReadImage', 'note'],
  propertyOrdering: ['canReadImage', 'note'],
} as const;

export function profileSummary(profile: TargetProfile | null): string {
  if (!profile) return 'No reference object analysed yet.';
  const strong = profile.attributes
    .filter((a) => a.distinctiveness === 'high')
    .map((a) => `${a.key}: ${a.value}`)
    .slice(0, 6);
  return [
    `TARGET: ${profile.name} (${profile.category})`,
    strong.length ? `KEY FEATURES: ${strong.join('; ')}` : '',
    profile.distinguishingColors.length ? `COLOURS: ${profile.distinguishingColors.join(', ')}` : '',
    profile.ambiguityRisks.length ? `CONFUSABLE WITH: ${profile.ambiguityRisks.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function analyzePrompt(): string {
  return [
    'You are the vision analyst of "Find Anything", a visual search agent.',
    'Study the single uploaded reference photo and build a profile that a camera operator can use to find THIS EXACT object in a live room.',
    '',
    'Rules:',
    '1. Describe only what is visible. Never invent a brand, model or text you cannot read.',
    '2. descriptors must be observable through a phone camera: colour, material, shape, pattern, logo, damage, wear, stickers, proportions.',
    '3. Mark attributes that survive different lighting/angles as distinctiveness "high".',
    '4. targetBBox: a TIGHT normalized box (x, y, width, height in 0..1 of the photo) around the target object in this photo.',
    '   It is used to cut a template for on-device matching, so it must hug the object (no floor, table or wall inside).',
    '5. If the photo contains several objects, pick the most clearly framed foreground object as the target and note the others in ambiguityRisks.',
    '6. If the photo has no usable object (blurry, empty, screenshot), say so in ambiguityRisks and still return your best profile.',
    '7. ambiguityRisks: list objects this could be confused with (e.g. "other white mugs", "phone on a stand").',
    '8. sceneGuidance: one practical sentence telling the user how to scan the room.',
    '9. searchHint: max 8 words, spoken aloud while searching.',
    '',
    'Reply ONLY with the JSON object matching the schema.',
  ].join('\n');
}

export function detectPrompt(profile: TargetProfile | null, extraContext: string[]): string {
  return [
    'You are the localisation engine of "Find Anything". You receive ONE live camera frame.',
    profileSummary(profile),
    '',
    'Decide whether the exact target object is visible in THIS frame and, if so, where.',
    '',
    'Output rules — follow exactly:',
    '1. "visible": true only when you can actually see the target with enough detail to confirm its identifying features.',
    '2. If visible, return "bbox" = [ymin, xmin, ymax, xmax] normalized to 0–1000 for the image you received,',
    '   OR the equivalent normalized object {x,y,width,height} where x,y = top-left in 0..1. Tight box around the object, no big context margins.',
    '3. If the target is NOT visible (occluded, out of frame, too blurry, only a look-alike), set "visible": false and OMIT "bbox" entirely.',
    '   Never output a box for a guess, a similar-but-different object, or an empty region.',
    '4. "confidence" is YOUR certainty (0..1). Use values below 0.5 when unsure instead of inventing a box.',
    '5. If several objects match, box the single best match and raise "candidatesConsidered".',
    '6. "reason": max 12 words, camera-facing (e.g. "mug visible left of the keyboard").',
    extraContext.length ? `\nEnvironment notes from the conversation so far:\n- ${extraContext.slice(-5).join('\n- ')}` : '',
    '',
    'Reply ONLY with the JSON object matching the schema.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function verifyPrompt(profile: TargetProfile | null): string {
  return [
    'You are a strict verification judge for "Find Anything".',
    profileSummary(profile),
    '',
    'You get the reference photo of the target and a candidate crop from the live camera.',
    'Answer ONE question: does the crop contain the SAME object as the reference — not merely the same class of object?',
    'Guidance:',
    '- Compare colour, shape, markings, damage, and context. Same object ≠ same category.',
    '- If the crop is blurry, dark, or only partially shows the object, answer visible=false with low confidence.',
    '- Return visible=true only for an actual instance of the reference object.',
    'Reply ONLY with the JSON object matching the schema.',
  ].join('\n');
}

export function capabilityPrompt(): string {
  return [
    'Capability self-check. Describe what you can see in the attached image in ONE short sentence,',
    'and set canReadImage=true if you received an image you can actually interpret, else false.',
    'Reply only with JSON matching the schema.',
  ].join('\n');
}

/**
 * System instruction for the Gemini Live session (voice + video).
 * The live model drives the conversation; localisation is done by the vision
 * pipeline, so the live model is told not to pretend to be a detector.
 */
export function liveSystemInstruction(options: {
  profile: TargetProfile | null;
  voiceStyle: 'calm' | 'energetic' | 'minimal';
}): string {
  const styleLine =
    options.voiceStyle === 'energetic'
      ? 'Voice style: upbeat, quick, encouraging.'
      : options.voiceStyle === 'minimal'
        ? 'Voice style: minimal. One short sentence per turn, then stop.'
        : 'Voice style: calm, warm, precise, never chatty.';

  return [
    'You are "Find Anything", a real-time visual-search companion speaking out loud while the user walks around a room pointing their phone camera.',
    styleLine,
    '',
    profileSummary(options.profile),
    '',
    'Your job:',
    '1. Guide the user on where to point the camera ("slowly pan left", "lower the camera towards the table").',
    '2. You may see video frames — use them to describe the scene and guide, but the app\'s vision pipeline is the only source of truth for the object\'s position.',
    '   NEVER invent a bounding box, never claim pixel coordinates, never say "it is exactly at the left third".',
    '3. Keep spoken turns to 1–2 short sentences. The user is holding a phone; be brief.',
    '4. Say what you see, ask for one movement at a time, and confirm progress ("Closer — I can see a shelf of mugs now").',
    '5. If the user asks for something you cannot do (open an app, buy something), politely decline in one line.',
    '',
    'IMPORTANT — hands-free tracking protocol:',
    'Every video frame is accompanied by an instruction to answer with a compact JSON status object on its own line.',
    'When a frame arrives with "reply with EXACTLY one line of JSON", your ENTIRE text output for that turn must be a single JSON object of the form:',
    '{"visible": true|false, "confidence": 0.0-1.0, "reason": "max 8 words", "guide": "short spoken instruction or empty", "guessBox": null}',
    'Set visible=false whenever you cannot clearly see the target — "visible": false is the correct, expected answer most of the time.',
    'Do not speak that JSON aloud; speak only the "guide" text and the conversational guidance.',
  ].join('\n');
}

export function liveScenePrompt(profile: TargetProfile | null): string {
  return [
    'Scene check.',
    `Target: ${profile?.name ?? 'unknown'}.`,
    'Look at the frame and reply with EXACTLY one line of JSON:',
    '{"visible": boolean, "confidence": number, "reason": string, "guide": string, "guessBox": null}',
    'visible=false unless the target is clearly identifiable. Never fill guessBox.',
    'You may additionally speak one short guiding sentence out loud.',
  ].join(' ');
}
